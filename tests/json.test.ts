import assert from "node:assert/strict";
import test from "node:test";

import {
  asBool,
  asNonNegativeNumber,
  asRecord,
  asString,
  asTrimmedString
} from "../src/json.js";

test("JSON guards keep arrays out of record boundaries", () => {
  assert.deepEqual(asRecord([]), {});
  assert.deepEqual(asRecord({ value: 1 }), { value: 1 });
  assert.equal(asString("  value  "), "  value  ");
  assert.equal(asTrimmedString("  value  "), "value");
  assert.equal(asTrimmedString("   "), undefined);
  assert.equal(asNonNegativeNumber("12"), 12);
  assert.equal(asNonNegativeNumber(-1), undefined);
  assert.equal(asBool(true), true);
  assert.equal(asBool("true"), undefined);
});
