import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const targets = {
  'windows-x64': 'x86_64-pc-windows-msvc',
  'macos-arm64': 'aarch64-apple-darwin',
};

function validateVersion(version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid release version');
}

function downloadBase(version, repository) {
  validateVersion(version);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/, 'Invalid repository');
  return `https://github.com/${repository}/releases/download/v${version}/`;
}

function assertPackageVersions(version) {
  const config = readJson(join(root, 'src-tauri/tauri.conf.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')
    .split('[[package]]').find((block) => /^name = "llm-gateway"$/m.test(block));
  const versions = [config.version, readJson(join(root, 'package.json')).version,
    lock.version, lock.packages[''].version, cargo.match(/^version = "([^"]+)"/m)?.[1],
    cargoLock?.match(/^version = "([^"]+)"/m)?.[1]];
  assert(versions.every((value) => value === version), 'Tag and all package versions must match');
  return config.plugins.updater.pubkey;
}

// Tauri stores base64-encoded Minisign text. Use Node's Ed25519 primitive,
// matching Minisign's packet/key ID, BLAKE2b prehash and trusted-comment checks.
// Client verification remains the official updater plugin's responsibility.
export function verifyUpdate(bytes, encodedSignature, encodedPublicKey) {
  const keyLines = Buffer.from(encodedPublicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const sigLines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  assert.equal(keyLines.length, 2, 'Invalid updater public key');
  assert.equal(sigLines.length, 4, 'Invalid updater signature');
  const key = Buffer.from(keyLines[1], 'base64');
  const packet = Buffer.from(sigLines[1], 'base64');
  const globalSignature = Buffer.from(sigLines[3], 'base64');
  assert.equal(key.length, 42, 'Invalid public key packet');
  assert.equal(key.subarray(0, 2).toString(), 'Ed', 'Invalid public key algorithm');
  assert.equal(packet.length, 74, 'Invalid signature packet');
  assert.equal(globalSignature.length, 64, 'Invalid trusted-comment signature');
  assert(key.subarray(2, 10).equals(packet.subarray(2, 10)), 'Signing key does not match app public key');
  assert(sigLines[2].startsWith('trusted comment: '), 'Missing trusted comment');
  const algorithm = packet.subarray(0, 2).toString();
  assert(['Ed', 'ED'].includes(algorithm), 'Unsupported signature algorithm');
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const signature = packet.subarray(10);
  const data = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  assert(verify(null, data, publicKey, signature), 'Update package signature verification failed');
  assert(verify(null, Buffer.concat([signature, Buffer.from(sigLines[2].slice(17))]), publicKey, globalSignature),
    'Trusted comment verification failed');
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

export function stageRelease({ platform, bundle, destination, version, repository, publicKey }) {
  assert(Object.hasOwn(targets, platform), 'Unsupported build platform');
  const base = downloadBase(version, repository);
  const files = filesUnder(bundle);
  const one = (suffix) => {
    const matches = files.filter((path) => basename(path).endsWith(suffix));
    assert.equal(matches.length, 1, `Expected exactly one ${suffix}, found ${matches.length}`);
    return matches[0];
  };
  mkdirSync(destination, { recursive: true });
  const assets = [];
  const platforms = {};
  const copy = (path, name) => {
    copyFileSync(path, join(destination, name));
    assets.push({ name, sha256: sha256(path) });
  };
  const signed = (path, name, target) => {
    const signature = readFileSync(`${path}.sig`, 'utf8').trim();
    verifyUpdate(readFileSync(path), signature, publicKey);
    copy(path, name);
    copy(`${path}.sig`, `${name}.sig`);
    platforms[target] = { url: base + name, signature };
  };
  if (platform === 'windows-x64') {
    signed(one(`_${version}_x64-setup.exe`), `LLM.Gateway_${version}_x64-setup.exe`, 'windows-x86_64-nsis');
    signed(one(`_${version}_x64_en-US.msi`), `LLM.Gateway_${version}_x64_en-US.msi`, 'windows-x86_64-msi');
    platforms['windows-x86_64'] = platforms['windows-x86_64-nsis'];
  } else {
    copy(one(`_${version}_aarch64.dmg`), `LLM.Gateway_${version}_aarch64.dmg`);
    signed(one('.app.tar.gz'), `LLM.Gateway_${version}_aarch64.app.tar.gz`, 'darwin-aarch64');
  }
  const manifest = { version, platforms, assets };
  writeFileSync(join(destination, `manifest-${platform}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function mergeRelease({ directory, version, repository, publicKey, notes = '' }) {
  const base = downloadBase(version, repository);
  const platforms = {};
  const assetNames = new Set();
  for (const platform of Object.keys(targets)) {
    const manifest = readJson(join(directory, `manifest-${platform}.json`));
    assert.equal(manifest.version, version, 'Mixed release versions');
    for (const asset of manifest.assets) {
      assert.match(asset.name, /^[\w.+-]+$/, 'Unsafe asset name');
      assert(asset.name.includes(`_${version}_`), 'Stale release asset');
      assert(!assetNames.has(asset.name), 'Duplicate release asset');
      assert.equal(sha256(join(directory, asset.name)), asset.sha256, 'Release artifact changed after staging');
      assetNames.add(asset.name);
    }
    for (const [target, entry] of Object.entries(manifest.platforms)) {
      assert(!Object.hasOwn(platforms, target), 'Duplicate updater target');
      assert(entry.url.startsWith(base), 'Updater URL must point to this immutable release');
      const name = entry.url.slice(base.length);
      assert(assetNames.has(name), 'Updater package is missing');
      assert(assetNames.has(`${name}.sig`), 'Updater signature file is missing');
      assert.equal(readFileSync(join(directory, `${name}.sig`), 'utf8').trim(), entry.signature,
        'Manifest signature does not match the uploaded signature');
      verifyUpdate(readFileSync(join(directory, name)), entry.signature, publicKey);
      platforms[target] = entry;
    }
  }
  assert.deepEqual(Object.keys(platforms).sort(),
    ['darwin-aarch64', 'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis']);
  assert.equal(assetNames.size, 7, 'Expected both installers, DMG, macOS updater and all signatures');
  const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
  writeFileSync(join(directory, 'latest.json'), JSON.stringify(manifest, null, 2));
  return [...assetNames, 'latest.json'].map((name) => join(directory, name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'clean') {
    const [platform] = args;
    assert(Object.hasOwn(targets, platform), 'Unsupported build platform');
    rmSync(join(root, 'src-tauri/target', targets[platform], 'release/bundle'), { recursive: true, force: true });
  } else if (command === 'stage') {
    const [platform, bundle, destination, tag, repository] = args;
    const version = tag.replace(/^v/, '');
    stageRelease({ platform, bundle, destination, version, repository, publicKey: assertPackageVersions(version) });
  } else if (command === 'manifest') {
    const [directory, tag, repository, notesFile] = args;
    const version = tag.replace(/^v/, '');
    const files = mergeRelease({ directory, version, repository, publicKey: assertPackageVersions(version),
      notes: notesFile ? readFileSync(notesFile, 'utf8') : '' });
    process.stdout.write(`${files.join('\n')}\n`);
  } else {
    throw new Error('Expected clean, stage or manifest command');
  }
}
