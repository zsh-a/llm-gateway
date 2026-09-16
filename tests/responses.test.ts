import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEffort } from "../src/domain/reasoning.js";
import { normalizeChatRequest } from "../src/protocols/chat.js";
import { normalizeResponseRequest } from "../src/protocols/responses/index.js";

test("Responses tool items use the native function call protocol", () => {
  const request = normalizeResponseRequest({
    model: "demo",
    input: [
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ]
  });

  assert.equal(request.messages[0].role, "assistant");
  assert.equal(request.messages[1].role, "tool");
  assert.equal(request.messages[1].tool_call_id, "call_1");
});

test("Responses rejects Chat tool message fields", () => {
  assert.throws(
    () => normalizeResponseRequest({
      model: "demo",
      input: [{
        type: "message",
        role: "assistant",
        content: "",
        tool_calls: []
      }]
    }),
    /不接受 Chat 工具字段/
  );
});

test("Chat requests use the snake_case reasoning field", () => {
  assert.throws(
    () => normalizeChatRequest({
      model: "demo",
      messages: [],
      reasoningEffort: "high"
    }),
    /仅支持 reasoning_effort/
  );
});

test("reasoning effort keeps the current minimal level as canonical", () => {
  assert.equal(normalizeEffort("minimal"), "minimal");
  assert.equal(normalizeEffort("ultra"), "medium");
});
