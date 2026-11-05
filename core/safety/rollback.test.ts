// Action journal.
//
// The state that matters is `pending`: planned, neither committed nor failed. That is
// the only state where the system genuinely does not know whether the side effect
// happened, and therefore the only state where guessing is dangerous.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commit, compensate, fail, journalFor, openActions, plan, read, states } from "./rollback.ts";

async function withJournal(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-actions-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a planned action is visible before it happens", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    await plan(journal, {
      action: "publish_post",
      detail: "post the launch announcement to the company page",
      compensation: "delete the post from the page",
    });

    const open = await openActions(journal);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.status, "pending");
    assert.equal(open[0]?.compensation, "delete the post from the page");
    assert.equal(open[0]?.irreversible, false);
  });
});

test("commit then compensate closes the action", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    const planned = await plan(journal, {
      action: "send_invoice",
      detail: "email invoice 0042",
      compensation: "send a correction email",
    });

    assert.ok(await commit(journal, planned.id));
    assert.equal((await openActions(journal)).length, 1, "an applied action is still open");

    assert.ok(await compensate(journal, planned.id, "client replied, invoice withdrawn"));
    assert.equal((await openActions(journal)).length, 0);

    const state = (await states(journal))[0];
    assert.equal(state?.status, "compensated");
    assert.match(state?.note ?? "", /withdrawn/);
  });
});

test("a failed action is closed and says why", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    const planned = await plan(journal, {
      action: "crm_sync",
      detail: "push contact",
      compensation: null,
    });

    await fail(journal, planned.id, "the CRM returned 502");
    assert.equal((await openActions(journal)).length, 0);
    const state = (await states(journal))[0];
    assert.equal(state?.status, "failed");
    assert.match(state?.note ?? "", /502/);
  });
});

test("an action with no compensation is recorded as irreversible, not omitted", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    await plan(journal, {
      action: "publish_post",
      detail: "post to a platform with no delete API",
      compensation: null,
    });

    const state = (await states(journal))[0];
    assert.equal(state?.irreversible, true);
    assert.equal(state?.compensation, null);
    assert.equal((await openActions(journal)).length, 1);
  });
});

test("a torn line costs one event, not the journal", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    await plan(journal, { action: "a", detail: "first", compensation: "undo a" });
    await writeFile(journal.file, '{"id":"half', { flag: "a" });
    await plan(journal, { action: "b", detail: "second", compensation: "undo b" });

    const events = await read(journal);
    assert.equal(events.length, 2);
    assert.deepEqual((await states(journal)).map((state) => state.action).sort(), ["a", "b"]);
  });
});

test("two identical plans in the same millisecond get distinct ids", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    const a = await plan(journal, { action: "publish", detail: "same text", compensation: "delete it" });
    const b = await plan(journal, { action: "publish", detail: "same text", compensation: "delete it" });
    assert.notEqual(a.id, b.id, "the id is how a compensation is matched to its effect");
    assert.equal((await states(journal)).length, 2);
  });
});

test("compensating an unknown id is null rather than a silent success", async () => {
  await withJournal(async (dir) => {
    const journal = journalFor(dir);
    assert.equal(await commit(journal, "nope"), null);
    assert.equal(await compensate(journal, "nope"), null);
  });
});
