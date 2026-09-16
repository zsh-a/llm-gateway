import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolHistory } from "../src/protocols/tool-history.js";

test("tool history normalizes matching assistant calls and results", () => {
  const messages = normalizeToolHistory([
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: { city: "Shanghai" } }
      }]
    },
    { role: "tool", tool_call_id: "call_1", content: { result: "ok" } }
  ]) as Array<Record<string, unknown>>;

  assert.equal(messages[1].role, "tool");
  assert.equal(messages[1].tool_call_id, "call_1");
  const call = (messages[0].tool_calls as Array<Record<string, unknown>>)[0];
  assert.deepEqual(call.function, {
    name: "lookup",
    arguments: JSON.stringify({ city: "Shanghai" })
  });
});

test("tool history rejects missing or orphaned results", () => {
  assert.throws(
    () => normalizeToolHistory([
      { role: "assistant", tool_calls: [{
        id: "call_1",
        function: { name: "lookup", arguments: "{}" }
      }] },
      { role: "user", content: "next" }
    ]),
    /缺少结果/
  );
  assert.throws(
    () => normalizeToolHistory([
      { role: "tool", tool_call_id: "missing", content: "nope" }
    ]),
    /孤立的工具结果/
  );
});

test("tool history rejects removed function message shapes", () => {
  assert.throws(
    () => normalizeToolHistory([{
      role: "assistant",
      function_call: { name: "lookup", arguments: "{}" }
    }]),
    /只支持 tool_calls/
  );
  assert.throws(
    () => normalizeToolHistory([
      { role: "assistant", tool_calls: [{
        id: "call_1",
        function: { name: "lookup", arguments: "{}" }
      }] },
      { role: "function", name: "lookup", content: "ok" }
    ]),
    /role=tool/
  );
});
