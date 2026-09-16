import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelStore } from "../src/channels.js";

function withChannelStore(
  channels: Array<Record<string, unknown>>,
  callback: (store: ChannelStore) => void
): void {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-channels-"));
  try {
    const file = join(directory, "channels.json");
    writeFileSync(file, JSON.stringify({ version: 1, channels }));
    callback(new ChannelStore(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("channel selection honors priority and weighted rotation", () => {
  withChannelStore([
    { id: "mimo-a", providerId: "mimo", authRef: "a", priority: 100, weight: 3, enabled: true },
    { id: "mimo-b", providerId: "mimo", authRef: "b", priority: 100, weight: 1, enabled: true },
    { id: "mimo-fallback", providerId: "mimo", authRef: "fallback", priority: 10, weight: 1, enabled: true }
  ], (store) => {
    const first = store.selectCandidates("mimo", "model", "model");
    const second = store.selectCandidates("mimo", "model", "model");
    store.selectCandidates("mimo", "model", "model");
    const fourth = store.selectCandidates("mimo", "model", "model");

    assert.equal(first[0].channel.id, "mimo-a");
    assert.equal(second[0].channel.id, "mimo-a");
    assert.equal(fourth[0].channel.id, "mimo-b");
    assert.deepEqual(
      first.slice(0, 2).map((item) => item.channel.id).sort(),
      ["mimo-a", "mimo-b"]
    );
    assert.equal(first.at(-1)?.channel.id, "mimo-fallback");
  });
});

test("channel cursor state is bounded for arbitrary model names", () => {
  withChannelStore([
    { id: "mimo-default", providerId: "mimo", authRef: "mimo", enabled: true }
  ], (store) => {
    for (let index = 0; index < 1100; index += 1) {
      store.selectCandidates("mimo", `model-${index}`, `model-${index}`);
    }
    const cursors = (store as unknown as { cursors: Map<string, number> }).cursors;
    assert.ok(cursors.size <= 1024);
  });
});
