import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeRelease, stageRelease, verifyUpdate } from './prepare-release.mjs';

const version = '1.2.3';
const repository = 'example/gateway';
const key = generateKeyPairSync('ed25519');
const keyId = randomBytes(8);
const publicPacket = Buffer.concat([Buffer.from('Ed'), keyId,
  key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
const publicKey = Buffer.from(`untrusted comment: test public key\n${publicPacket.toString('base64')}\n`).toString('base64');

function signature(bytes, algorithm = 'ED') {
  const data = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const raw = sign(null, data, key.privateKey);
  const packet = Buffer.concat([Buffer.from(algorithm), keyId, raw]);
  const comment = 'timestamp:1\tfile:fixture\tprehashed';
  const global = sign(null, Buffer.concat([raw, Buffer.from(comment)]), key.privateKey);
  return Buffer.from(`untrusted comment: test signature\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const windows = join(directory, 'windows');
  const macos = join(directory, 'macos');
  const staged = join(directory, 'staged');
  mkdirSync(windows);
  mkdirSync(macos);
  for (const [folder, name] of [
    [windows, `LLM Gateway_${version}_x64-setup.exe`],
    [windows, `LLM Gateway_${version}_x64_en-US.msi`],
    [macos, 'LLM Gateway.app.tar.gz'],
  ]) {
    const path = join(folder, name);
    const bytes = Buffer.from(`fixture package ${name}`);
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sig`, signature(bytes));
  }
  writeFileSync(join(macos, `LLM Gateway_${version}_aarch64.dmg`), 'dmg fixture');
  const stage = (platform, bundle) => stageRelease({ platform, bundle, destination: staged, version, repository, publicKey });
  const merge = () => mergeRelease({ directory: staged, version, repository, publicKey, notes: 'Test update' });
  return { directory, windows, macos, staged, stage, merge };
}

test('verifies prehashed and legacy signatures; rejects altered bytes and trusted comments', () => {
  const bytes = Buffer.from('signed package');
  for (const algorithm of ['ED', 'Ed']) {
    const sig = signature(bytes, algorithm);
    verifyUpdate(bytes, sig, publicKey);
    assert.throws(() => verifyUpdate(Buffer.from('modified package'), sig, publicKey), /signature verification failed/);
    const changed = Buffer.from(Buffer.from(sig, 'base64').toString().replace('timestamp:1', 'timestamp:2')).toString('base64');
    assert.throws(() => verifyUpdate(bytes, changed, publicKey), /Trusted comment verification failed/);
  }
});

test('publishes a complete signed manifest preserving both Windows installer types', (t) => {
  const f = fixture(t);
  f.stage('windows-x64', f.windows);
  f.stage('macos-arm64', f.macos);
  const files = f.merge();
  assert.equal(files.length, 8);
  assert(files.every(existsSync));
  const manifest = JSON.parse(readFileSync(join(f.staged, 'latest.json')));
  assert.equal(manifest.version, version);
  assert.equal(manifest.notes, 'Test update');
  assert.match(manifest.platforms['windows-x86_64-msi'].url, /_x64_en-US\.msi$/);
  assert.match(manifest.platforms['windows-x86_64-nsis'].url, /_x64-setup\.exe$/);
  assert.match(manifest.platforms['darwin-aarch64'].url, /_aarch64\.app\.tar\.gz$/);
  assert(Object.values(manifest.platforms).every((entry) => entry.url.startsWith(`https://github.com/${repository}/releases/download/v${version}/`)));
});

test('refuses to publish when one platform is missing', (t) => {
  const f = fixture(t);
  f.stage('windows-x64', f.windows);
  assert.throws(f.merge, /ENOENT/);
  assert(!existsSync(join(f.staged, 'latest.json')));
});

test('refuses mismatched signing keys and corrupted update packages', (t) => {
  const f = fixture(t);
  const file = join(f.windows, `LLM Gateway_${version}_x64-setup.exe`);
  const wrongKey = Buffer.from(publicPacket);
  wrongKey[2] ^= 1;
  const encoded = Buffer.from(`untrusted comment: wrong key\n${wrongKey.toString('base64')}\n`).toString('base64');
  assert.throws(() => stageRelease({ platform: 'windows-x64', bundle: f.windows, destination: f.staged, version, repository, publicKey: encoded }), /key does not match/);
  writeFileSync(file, 'corrupt download');
  assert.throws(() => f.stage('windows-x64', f.windows), /signature verification failed/);
});

test('detects modified artifacts and mixed versions before writing latest.json', (t) => {
  const f = fixture(t);
  f.stage('windows-x64', f.windows);
  f.stage('macos-arm64', f.macos);
  const exe = join(f.staged, `LLM.Gateway_${version}_x64-setup.exe`);
  writeFileSync(exe, 'changed after upload');
  assert.throws(f.merge, /changed after staging/);
  f.stage('windows-x64', f.windows);
  const path = join(f.staged, 'manifest-macos-arm64.json');
  const manifest = JSON.parse(readFileSync(path));
  manifest.version = '1.2.2';
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(f.merge, /Mixed release versions/);
  assert(!existsSync(join(f.staged, 'latest.json')));
});

test('does not pick an ambiguous cached macOS updater', (t) => {
  const f = fixture(t);
  cpSync(join(f.macos, 'LLM Gateway.app.tar.gz'), join(f.macos, 'Old.app.tar.gz'));
  assert.throws(() => f.stage('macos-arm64', f.macos), /Expected exactly one/);
});
