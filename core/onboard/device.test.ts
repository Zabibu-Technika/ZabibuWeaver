// Device onboarding.
//
// The recommendation is a pure function of a profile, so the thresholds and the disk
// downgrade are testable without a particular machine.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultBaseWorkspace,
  ensureBaseWorkspace,
  permissionAdvice,
  recommendModel,
} from "./device.ts";

test("the base workspace is one directory outside the system", () => {
  const path = defaultBaseWorkspace("/home/teh");
  assert.match(path, /\.weaver[\\/]workspace$/);
  assert.doesNotMatch(path, /^\/etc|^C:\\Windows/i);
});

test("the recommendation is the largest model that fits RAM", () => {
  assert.equal(recommendModel({ ramGb: 4, freeDiskGb: 100 }).id, "qwen2.5-coder:1.5b");
  assert.equal(recommendModel({ ramGb: 8, freeDiskGb: 100 }).id, "qwen2.5-coder:7b");
  assert.equal(recommendModel({ ramGb: 16, freeDiskGb: 100 }).id, "qwen2.5-coder:14b");
  assert.equal(recommendModel({ ramGb: 32, freeDiskGb: 100 }).id, "qwen2.5-coder:32b");
});

test("low disk downgrades the recommendation", () => {
  assert.equal(recommendModel({ ramGb: 32, freeDiskGb: 8 }).id, "qwen2.5-coder:7b");
  assert.equal(recommendModel({ ramGb: 8, freeDiskGb: 5 }).id, "qwen2.5-coder:1.5b");
});

test("admin advice never implies full access", () => {
  const admin = permissionAdvice({ admin: true, freeDiskGb: 100 }).join(" ");
  assert.match(admin, /administrator/i);
  assert.match(admin, /still ask/i);
  assert.doesNotMatch(admin, /full access is fine/i);

  const standard = permissionAdvice({ admin: false, freeDiskGb: 100 }).join(" ");
  assert.match(standard, /standard user/i);
  assert.match(standard, /base workspace/i);
});

test("low disk is called out", () => {
  assert.match(permissionAdvice({ admin: false, freeDiskGb: 4 }).join(" "), /smaller model/i);
});

test("the base workspace is created on demand", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-base-"));
  try {
    const path = join(dir, "workspace");
    await ensureBaseWorkspace(path);
    const info = await stat(path);
    assert.equal(info.isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
