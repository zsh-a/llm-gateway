import assert from "node:assert/strict";
import test from "node:test";
import { credentialHeaders, getProvider } from "./auth-support.js";

test("WorkBuddy client version survives authentication capture and vault normalization", () => {
  assert.ok(getProvider("workbuddy")?.captureHeaders.includes("user-agent"));
  const headers = credentialHeaders({
    Authorization: "Bearer test",
    "User-Agent": "WorkBuddy/5.5.6",
    Host: "copilot.tencent.com",
  });
  assert.equal(headers?.["User-Agent"], "WorkBuddy/5.5.6");
  assert.equal(headers?.Host, undefined);
  assert.equal(credentialHeaders(headers)?.["User-Agent"], "WorkBuddy/5.5.6");
  assert.equal(credentialHeaders({ "User-Agent": "WorkBuddy/5.5.6" }), null);
});
