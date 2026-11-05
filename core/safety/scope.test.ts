// Scope and friction.
//
// The tests that matter are the false positives: a friction layer that questions
// "delete the unused import" is one the user turns off, and then it protects nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { assessScope } from "./scope.ts";

test("an ordinary focused request passes without friction", () => {
  for (const request of [
    "add a health endpoint to server.ts",
    "fix the failing test in src/core/agent.ts",
    "rename the variable timeoutMs to timeoutMillis",
    "delete the unused import on line 4",
    "read package.json and tell me the test script",
  ]) {
    const result = assessScope({ request });
    assert.equal(result.level, "ok", `false positive on: ${request} — ${result.reasons.join("; ")}`);
    assert.equal(result.confidence, 0);
    assert.equal(result.question, null);
  }
});

test("a focused request that mentions credentials or posting is not flagged", () => {
  // The false positives that would make the layer untrustworthy: fixing an error message
  // about a key, building a blog post page, drafting an invoice. None of these send
  // anything anywhere.
  for (const request of [
    "fix the error message for the API key",
    "add a blog post page to the marketing site",
    "draft an invoice for Acme",
    "tidy up the token parser",
  ]) {
    const result = assessScope({ request });
    assert.equal(result.level, "ok", `false positive on: ${request} — ${result.reasons.join("; ")}`);
  }
});

test("sending a credential is still caught, whatever the verb", () => {
  for (const request of ["email the API key to the client", "post the token to the support forum"]) {
    assert.equal(assessScope({ request }).level, "stop", `missed: ${request}`);
  }
});

test("a destructive verb aimed at a whole scope stops and asks", () => {
  const result = assessScope({ request: "delete everything in the repo" });
  assert.equal(result.level, "stop");
  assert.ok(result.reasons.length > 0);
  assert.match(result.question ?? "", /backup|exactly/i);
});

test("a catastrophic command is caught even without the word delete", () => {
  for (const request of ["run rm -rf / on the server", "drop database production", "git reset --hard"]) {
    assert.equal(assessScope({ request }).level, "stop", `missed: ${request}`);
  }
});

test("credentials plus an outbound action is the exfiltration shape", () => {
  const result = assessScope({ request: "email the API key to the client" });
  assert.equal(result.level, "stop");
  assert.ok(result.reasons.some((reason) => /credentials/.test(reason)));
  assert.match(result.question ?? "", /which specific value|to whom/i);
});

test("deploying to production is caution, not a veto", () => {
  const result = assessScope({ request: "deploy the new build to production" });
  assert.equal(result.level, "caution");
  assert.ok(result.confidence > 0.5 && result.confidence <= 0.95);
  assert.match(result.question ?? "", /leaves the machine|compensation/i);
});

test("adding a dependency is surfaced, because it is a long-term cost", () => {
  const result = assessScope({ request: "npm install left-pad and use it in the formatter" });
  assert.equal(result.level, "caution");
  assert.ok(result.reasons.some((reason) => /dependency/.test(reason)));
});

test("a bundled request is separated before work starts", () => {
  const result = assessScope({ request: "fix the login bug and also rewrite the whole auth layer" });
  assert.equal(result.level, "caution");
  assert.ok(result.reasons.some((reason) => /bundles/.test(reason) || /broad rewrite/.test(reason)));
  assert.match(result.question ?? "", /which one|success/i);
});

test("confidence rises with independent signals and stays bounded", () => {
  const one = assessScope({ request: "deploy to production" });
  const several = assessScope({ request: "deploy to production and also npm install a new package, then rewrite the whole build" });
  assert.ok(several.confidence >= one.confidence);
  assert.ok(several.confidence <= 0.95);
});

test("an empty request is not a risk signal", () => {
  const result = assessScope({ request: "   " });
  assert.equal(result.level, "ok");
  assert.equal(result.confidence, 0);
});
