import assert from "node:assert/strict";
import test from "node:test";

import {
  createResponseContext,
  normalizeResponseRequest,
  rememberResponse,
  ResponseAccumulator
} from "../src/responses.js";
import { InMemoryResponseStore } from "../src/response-store.js";

test("Responses storage honors store=false and isolates owners", () => {
  const store = new InMemoryResponseStore();
  const request = normalizeResponseRequest({
    model: "demo",
    input: "hello",
    store: false
  });
  const context = createResponseContext("demo");
  const accumulator = new ResponseAccumulator();
  accumulator.add({ choices: [{ delta: { content: "world" } }] });

  rememberResponse(context, request, accumulator, store, "key-a");
  assert.equal(store.get(context.id, "key-a"), null);

  const storedRequest = normalizeResponseRequest({
    model: "demo",
    input: "hello",
    store: true
  });
  rememberResponse(context, storedRequest, accumulator, store, "key-a");
  assert.ok(store.get(context.id, "key-a"));
  assert.equal(store.get(context.id, "key-b"), null);
});

test("previous_response_id reads from the injected store", () => {
  const store = new InMemoryResponseStore();
  const request = normalizeResponseRequest({
    model: "demo",
    input: "hello",
    store: true
  });
  const context = createResponseContext("demo");
  const accumulator = new ResponseAccumulator();
  accumulator.add({ choices: [{ delta: { content: "world" } }] });
  rememberResponse(context, request, accumulator, store, "key-a");

  const next = normalizeResponseRequest({
    model: "demo",
    previous_response_id: context.id,
    input: "again"
  }, "", { responseStore: store, owner: "key-a" });

  assert.deepEqual(
    next.messages.map((message) => message.role),
    ["user", "assistant", "user"]
  );
  assert.equal(next.messages[1].content, "world");
});
