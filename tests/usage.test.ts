import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUsage } from "../src/observability/usage.js";

test("usage normalization reconciles aliases without double counting", () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: "10",
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 3 },
      input_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 2 }
    }),
    {
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 2,
      cachedTokens: 5,
      inputDetails: { cachedTokens: 5 },
      outputDetails: { reasoningTokens: 2 },
      totalTokens: 14
    }
  );
});
