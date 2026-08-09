import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCompleted } from "../extensions/trellis-task-board/mutation.ts";

function fixtureChecklist(): string {
  const root = mkdtempSync(join(tmpdir(), "ttb-mut-"));
  const dir = join(root, ".trellis", "tasks", "T1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({ id: "T1", title: "T1", status: "in_progress" }), "utf8");
  const md = "## Checklist\r\n\r\n- [ ] alpha\r\n- [ ] bravo\r\n- [x] charlie\r\n";
  writeFileSync(join(dir, "implement.md"), md, "utf8");
  const sess = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(sess, { recursive: true });
  writeFileSync(
    join(sess, "pi_s1.json"),
    JSON.stringify({ platform: "pi", current_task: ".trellis/tasks/T1", current_run: null }),
    "utf8",
  );
  return root;
}

test("setCompleted toggles a checkbox marker and preserves CRLF", async () => {
  const root = fixtureChecklist();
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const text = readFileSync(join(root, ".trellis", "tasks", "T1", "implement.md"), "utf8");
  assert.ok(text.includes("- [x] alpha\r\n- [ ] bravo\r\n"));
  assert.ok(!text.includes("- [ ] alpha"));
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted is a no-op when already in requested state", async () => {
  const root = fixtureChecklist();
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "alpha",
    completed: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
  const text = readFileSync(join(root, ".trellis", "tasks", "T1", "implement.md"), "utf8");
  assert.ok(text.includes("- [ ] alpha"));
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects wrong expected text", async () => {
  const root = fixtureChecklist();
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "wrong",
    completed: true,
  });
  assert.equal(res.ok, false);
  const text = readFileSync(join(root, ".trellis", "tasks", "T1", "implement.md"), "utf8");
  assert.ok(text.includes("- [ ] alpha"), "no mutation on mismatch");
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects out-of-range item", async () => {
  const root = fixtureChecklist();
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 99,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects legacy numbered plan", async () => {
  const root = fixtureChecklist();
  const dir = join(root, ".trellis", "tasks", "T1");
  writeFileSync(join(dir, "implement.md"), "## Checklist\n\n1. one\n2. two\n", "utf8");
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "one",
    completed: true,
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /legacy|read-only/i);
  assert.ok(readFileSync(join(dir, "implement.md"), "utf8").includes("1. one"), "no mutation");
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects planning state", async () => {
  const root = fixtureChecklist();
  const dir = join(root, ".trellis", "tasks", "T1");
  writeFileSync(join(dir, "task.json"), JSON.stringify({ id: "T1", status: "planning" }), "utf8");
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects untrusted project", async () => {
  const root = fixtureChecklist();
  const res = await setCompleted(root, { sessionId: "s1" }, false, {
    item: 1,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, false);
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects a missing implement.md (never creates a file)", async () => {
  const root = fixtureChecklist();
  const dir = join(root, ".trellis", "tasks", "T1");
  rmSync(join(dir, "implement.md"), { force: true });
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, false);
  assert.equal(existsSync(join(dir, "implement.md")), false, "file must not be created");
  rmSync(root, { recursive: true, force: true });
});

test("setCompleted rejects a task ref escaping .trellis/tasks", async () => {
  const root = fixtureChecklist();
  const sess = join(root, ".trellis", ".runtime", "sessions");
  writeFileSync(
    join(sess, "pi_s1.json"),
    JSON.stringify({ current_task: "../../../outside" }),
    "utf8",
  );
  const res = await setCompleted(root, { sessionId: "s1" }, true, {
    item: 1,
    expectedText: "alpha",
    completed: true,
  });
  assert.equal(res.ok, false);
  rmSync(root, { recursive: true, force: true });
});