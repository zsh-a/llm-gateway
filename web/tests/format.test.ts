import { describe, expect, it } from "vitest";
import { formatDuration, usageTotal } from "../src/lib/format";

describe("diagnostic value accuracy", () => {
  it("does not double-count reasoning or turn partial usage into a known total", () => {
    expect(usageTotal({ inputTokens: 5, outputTokens: 3, reasoningTokens: 2 })).toBe(8);
    expect(usageTotal({ inputTokens: 5 })).toBeUndefined();
    expect(usageTotal({ outputTokens: 3, reasoningTokens: 2 })).toBeUndefined();
    expect(usageTotal({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(usageTotal({ totalTokens: 0, inputTokens: 5 })).toBe(0);
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(undefined)).toBe("—");
  });
});
