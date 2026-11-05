// Containment.
//
// The property under test is not "does this sandbox work" — that needs the OS, and half
// these backends are not on the machine that runs CI. It is the one that actually matters
// and is fully testable here: **an absent sandbox is never silent.** Every plan states its
// gaps, and the `none` backend produces a disclosure the caller is expected to pass to the
// human rather than a null it can ignore.
import assert from "node:assert/strict";
import test from "node:test";
import { detect, disclosureText, needsDisclosure, plan, seatbeltProfile, type Capability } from "./sandbox.ts";

const WORKSPACE = "/home/user/project";

const NONE: Capability = {
  backend: "none",
  contains: [],
  reason: "no sandbox backend for test",
  advisories: [],
};

const SEATBELT: Capability = {
  backend: "seatbelt",
  contains: ["fs-write", "process"],
  advisories: ["sandbox-exec is deprecated"],
};

const LANDLOCK: Capability = {
  backend: "landlock",
  contains: ["fs-write", "process"],
  advisories: [],
};

const WSL: Capability = { backend: "wsl", contains: ["fs-write", "network", "process"], advisories: [] };

// --- The Seatbelt profile ----------------------------------------------------

test("the Seatbelt profile denies writes by default and scopes the allowance to the workspace", () => {
  const profile = seatbeltProfile(WORKSPACE, false);
  assert.match(profile, /\(deny file-write\*\)/, "must deny writes before allowing any back");
  assert.match(profile, new RegExp(`\\(literal "${WORKSPACE}"\\)`), "the workspace must be the allowance");
  // Every allow is an allowance an attacker also gets, so the profile stays small.
  assert.ok(profile.split("\n").length < 20, "a profile nobody has read is one nobody can defend");
});

test("network is denied unless it was asked for, because default-off is the point", () => {
  assert.match(seatbeltProfile(WORKSPACE, false), /\(deny network\*\)/);
  assert.doesNotMatch(seatbeltProfile(WORKSPACE, true), /\(deny network\*\)/);
});

// --- Planning ----------------------------------------------------------------

test("an uncontained command is wrapped in nothing and says so", async () => {
  const result = await plan({ workspace: WORKSPACE, argv: ["npm", "test"] }, NONE);
  assert.equal(result.backend, "none");
  assert.deepEqual(result.command, ["npm", "test"], "it must not pretend to have wrapped anything");
  assert.deepEqual(result.contains, []);
  assert.ok(result.disclosure !== null, "absence of containment must produce a disclosure");
  assert.match(result.disclosure, /No operating-system sandbox is available/);
  assert.match(result.disclosure, /checkpoint your files first/, "the disclosure should name the fallback");
});

test("every plan states what it does NOT stop", async () => {
  // A plan that lists protections and omits its gaps is the document that gets someone
  // breached. This is the invariant worth the most in the module.
  for (const capability of [NONE, SEATBELT, LANDLOCK, WSL]) {
    const result = await plan({ workspace: WORKSPACE, argv: ["echo", "hi"] }, capability);
    assert.ok(result.gaps.length > 0, `${capability.backend} must declare its gaps`);
    for (const gap of result.gaps) {
      assert.ok(gap.length > 30, `${capability.backend} gap is too vague to be useful: ${gap}`);
    }
  }
});

test("Seatbelt wraps the command behind sandbox-exec", async () => {
  const result = await plan({ workspace: WORKSPACE, argv: ["npm", "test"] }, SEATBELT);
  assert.equal(result.backend, "seatbelt");
  assert.deepEqual(result.command.slice(0, 2), ["/usr/bin/sandbox-exec", "-p"]);
  assert.equal(result.command.at(-1), "test", "the original argv must survive intact");
  assert.equal(result.disclosure, null, "a contained command needs no absence disclosure");
});

test("a Seatbelt plan without network asks the profile to deny it", async () => {
  const offline = await plan({ workspace: WORKSPACE, argv: ["npm", "test"], network: false }, SEATBELT);
  const profile = offline.command[2];
  assert.ok(typeof profile === "string");
  assert.match(profile, /\(deny network\*\)/);

  const online = await plan({ workspace: WORKSPACE, argv: ["curl", "https://x.test"], network: true }, SEATBELT);
  assert.doesNotMatch(String(online.command[2]), /\(deny network\*\)/);
});

test("a Landlock plan runs the command directly, because the restriction is in-process", async () => {
  const result = await plan({ workspace: WORKSPACE, argv: ["npm", "test"] }, LANDLOCK);
  assert.deepEqual(result.command, ["npm", "test"]);
  assert.equal(result.backend, "landlock");
  assert.ok(result.gaps.some((gap) => /one-way/.test(gap)), "the one-way property is a real operational consequence");
});

test("a WSL plan translates the workspace into its Linux mount path", async () => {
  const result = await plan({ workspace: "C:\\Users\\dev\\project", argv: ["npm", "test"] }, WSL);
  assert.equal(result.command[0], "wsl.exe");
  // Lowercase drive letter: WSL mounts are /mnt/c, and getting this wrong makes --cd
  // fail silently rather than erroring.
  assert.ok(result.command.includes("/mnt/c/Users/dev/project"), `got: ${result.command.join(" ")}`);
  // The argv is rejoined into a single `sh -c` string, which is what the escaping test
  // below then verifies is safe to parse.
  assert.equal(result.command.at(-1), "npm test");
});

test("a WSL plan escapes shell metacharacters rather than letting them through", async () => {
  const result = await plan(
    { workspace: "C:\\Users\\dev\\project", argv: ["echo", 'a "b" $HOME `c`'] },
    WSL,
  );
  const shell = String(result.command.at(-1));
  // Every one of these is a way for an argument to become an instruction to `sh` rather
  // than data for it — which is the same confused-deputy shape the whole trust layer is
  // about, arriving through the back door of a path translation.
  assert.match(shell, /\\"/, `quotes must be escaped: ${shell}`);
  assert.match(shell, /\\\$/, `variable expansion must be escaped: ${shell}`);
  assert.match(shell, /\\`/, `command substitution must be escaped: ${shell}`);
});

// --- Detection ---------------------------------------------------------------

test("detection reports a real backend or an honest reason, never silence", async () => {
  const capability = await detect(WORKSPACE);
  assert.ok(["landlock", "seatbelt", "wsl", "none"].includes(capability.backend));
  if (capability.backend === "none") {
    assert.ok(capability.reason !== undefined && capability.reason.length > 10, "unavailable must say why");
  }
  for (const advisory of capability.advisories) {
    assert.ok(advisory.length > 30, `advisory too vague to act on: ${advisory}`);
  }
});

test("needsDisclosure is true only when there is nothing containing the command", () => {
  assert.equal(needsDisclosure(NONE), true);
  assert.equal(needsDisclosure(SEATBELT), false);
  assert.equal(needsDisclosure(LANDLOCK), false);
  assert.equal(needsDisclosure(WSL), false);
});

test("a disclosure for a contained backend names the backend and its caveats", () => {
  const text = disclosureText(SEATBELT);
  assert.match(text, /seatbelt containment/);
  assert.match(text, /deprecated/, "even working containment carries its advisories");
});

test("a disclosure for no backend names the consequence in plain language", () => {
  const text = disclosureText(NONE);
  assert.match(text, /same access you have/);
  assert.match(text, /nothing is stopping it/);
  assert.ok(!/undefined/.test(text), "the reason must be interpolated, not left as a placeholder");
});
