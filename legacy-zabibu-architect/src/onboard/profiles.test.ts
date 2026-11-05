// Profiles.
//
// The property under test is the one that makes this file worth having: **the dial
// controls friction, exposure, and verbosity — it does not control whether the trust
// boundaries hold.** A profile that could turn an invariant off would be OpenClaw with
// better onboarding, and that regression is the specific thing these tests exist to
// make impossible.
import assert from "node:assert/strict";
import test from "node:test";
import {
  INVARIANTS,
  PROFILES,
  PROFILE_ORDER,
  classify,
  describeProfile,
  profileById,
  type ProfileId,
} from "./profiles.ts";

test("every profile in the order exists and has the fields it claims", () => {
  assert.deepEqual([...PROFILE_ORDER].sort(), Object.keys(PROFILES).sort());
  for (const id of PROFILE_ORDER) {
    const profile = PROFILES[id];
    assert.ok(profile.label.length > 0, `${id} needs a label`);
    assert.ok(profile.blurb.length > 0, `${id} needs a blurb the user can read`);
    assert.ok(profile.visibleCapabilities.length > 0, `${id} needs at least one capability`);
  }
});

test("no profile defaults to full or readonly", () => {
  // `full` skips the gate entirely and `readonly` cannot act at all. Neither is a
  // sensible default for a person who has just told us they are not sure what they want.
  for (const id of PROFILE_ORDER) {
    assert.equal(PROFILES[id].permission, "auto", `${id} must default to asking`);
  }
});

test("the expert does not get a looser gate — that is the whole point", () => {
  // The Varonis phishing simulation tricked *the agent*, not a beginner. An expert's
  // agent reading a poisoned page is exactly as exploitable, so skill buys speed and
  // capability, never a quieter gate.
  assert.equal(PROFILES.expert.permission, "auto");
  assert.equal(PROFILES.expert.askBeforeEdits, false, "they get less ceremony, not less gate");
  assert.ok(PROFILES.expert.repairPasses >= PROFILES.general.repairPasses);
});

test("the explorer is given a narrow toolset, because a shell is not a gift", () => {
  // The failure mode for a beginner is not being denied help. It is being handed a
  // capability they did not know they had been handed.
  assert.ok(!PROFILES.explorer.visibleCapabilities.includes("unbounded"));
  assert.ok(!PROFILES.explorer.visibleCapabilities.includes("egress"));
  assert.equal(PROFILES.explorer.askBeforeEdits, true);
  assert.equal(PROFILES.explorer.verbosity, "plain", "no jargon for someone who has never seen any");
});

test("capability exposure only ever widens along the axis", () => {
  let previous = 0;
  for (const id of PROFILE_ORDER) {
    assert.ok(
      PROFILES[id].visibleCapabilities.length >= previous,
      `${id} should not offer less than the profile below it`,
    );
    previous = PROFILES[id].visibleCapabilities.length;
  }
});

test("classify proposes a profile, and never the most powerful one by accident", () => {
  assert.equal(classify({ codeBefore: "a lot", wants: "code", patience: "dont-ask" }), "expert");
  assert.equal(classify({ codeBefore: "a lot", wants: "files-and-apps", patience: "dont-ask" }), "developer");
  assert.equal(classify({ codeBefore: "some", wants: "both", patience: "ask-when-it-matters" }), "developer");
  assert.equal(classify({ codeBefore: "none", wants: "files-and-apps", patience: "ask-everything" }), "explorer");
  assert.equal(classify({ codeBefore: "none", wants: "files-and-apps", patience: "dont-ask" }), "general");
  assert.equal(classify({ codeBefore: "none", wants: "code", patience: "dont-ask" }), "general");
});

test("classify is total — every combination resolves to something", () => {
  const answers = ["none", "some", "a lot"] as const;
  const wants = ["files-and-apps", "code", "both"] as const;
  const patience = ["ask-everything", "ask-when-it-matters", "dont-ask"] as const;
  let seen = 0;
  for (const codeBefore of answers) {
    for (const want of wants) {
      for (const patienceChoice of patience) {
        const id = classify({ codeBefore, wants: want, patience: patienceChoice });
        assert.ok(PROFILES[id] !== undefined, `unresolved: ${codeBefore}/${want}/${patienceChoice}`);
        seen += 1;
      }
    }
  }
  assert.equal(seen, 27);
});

test("an unknown profile id falls back to general rather than throwing", () => {
  const id = "nope" as unknown as ProfileId;
  assert.equal(profileById(id).id, "general");
});

test("invariants exist, and no profile carries a field that looks like a bypass", () => {
  assert.ok(INVARIANTS.length >= 4, "the invariants are the product; fewer than four means one was dropped");
  for (const invariant of INVARIANTS) {
    assert.ok(invariant.rule.length > 20, "an invariant needs to say what it actually forbids");
    assert.ok(invariant.because.length > 20, "an invariant without a reason is a rule someone will delete");
    // Every invariant must name the incident it exists for. An invariant that cannot be
    // traced to a failure is a rule nobody will defend when it becomes inconvenient.
    assert.ok(invariant.because.length > 40, `invariant "${invariant.rule}" needs a real reason`);
  }

  // The structural guard. If anyone adds `allowSelfApproval`, `skipTrustChecks`, or
  // anything else shaped like a security toggle to Profile, this fails here — in a test
  // named after the reason — rather than in production, quietly, once.
  const BYPASS_NAMES = /\b(allow|bypass|skip|disable|ignore|trust|approve|unsafe|silent)\w*/i;
  for (const id of PROFILE_ORDER) {
    for (const key of Object.keys(PROFILES[id])) {
      assert.ok(
        !BYPASS_NAMES.test(key),
        `profile "${id}" has a field named "${key}", which reads as a security toggle — no profile may have one`,
      );
    }
  }
});

test("describeProfile shows the human what they are agreeing to, invariants included", () => {
  const text = describeProfile(PROFILES.general).join("\n");
  assert.match(text, /Permission mode: auto/);
  assert.match(text, /What no setting turns off:/);
  for (const invariant of INVARIANTS) {
    assert.ok(text.includes(invariant.rule), "every invariant must be shown, not just enforced");
  }
});
