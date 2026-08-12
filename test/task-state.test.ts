import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findTrellisRoot,
  findTrellisRoots,
  hash,
  isPathInside,
  loadSnapshot,
  resolveContextKeys,
  sanitizeKey,
} from "../extensions/trellis-task-board/task-state.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ttb-test-"));
  return dir;
}

function writeSession(root: string, key: string, ref: string): string {
  const dir = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${key}.json`);
  writeFileSync(p, JSON.stringify({ platform: "pi", current_task: ref, current_run: null }), "utf8");
  return p;
}

function writeTask(root: string, name: string, status: string, implement?: string): string {
  const dir = join(root, ".trellis", "tasks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({ id: name, title: `Title ${name}`, status }), "utf8");
  if (implement !== undefined) {
    writeFileSync(join(dir, "implement.md"), implement, "utf8");
  }
  return dir;
}

test("hash matches sha256 hex prefix 24", () => {
  assert.equal(hash("abc@def: ghi"), "8b0c170c9ae091e719149998");
});

test("sanitizeKey mirrors Python _sanitize_key", () => {
  assert.equal(sanitizeKey("abc@def: ghi"), "abc_def_ghi");
  assert.equal(sanitizeKey("  hello  "), "hello");
  assert.equal(sanitizeKey("..--hello..--"), "hello");
  assert.equal(sanitizeKey(".".repeat(200)), "");
  assert.equal(sanitizeKey("!!!"), "");
});

test("resolveContextKeys: normal UUID yields single plain key", () => {
  const keys = resolveContextKeys({ sessionId: "019fe20a-4176-7489-bdd9-c011c272a6b1" });
  assert.deepEqual(keys, ["pi_019fe20a-4176-7489-bdd9-c011c272a6b1"]);
});

test("resolveContextKeys: unusual id yields primary+secondary candidates", () => {
  const keys = resolveContextKeys({ sessionId: "abc@def: ghi" });
  assert.deepEqual(keys, ["pi_abc_def_ghi_8b0c170c9ae091e719149998", "pi_abc_def_ghi"]);
});

test("resolveContextKeys: empty-with-only-separators falls back to hash", () => {
  const keys = resolveContextKeys({ sessionId: "!!!" });
  // primary replicates the current Pi extension writer (does not strip separators)
  // secondary replicates the Python _sanitize_key (strips separators -> hash form)
  assert.deepEqual(keys, [`pi___${hash("!!!")}`, `pi_${hash("!!!")}`]);
});

test("resolveContextKeys: transcript candidate", () => {
  const keys = resolveContextKeys({ transcriptPath: "/some/sess.json" });
  assert.equal(keys[0], `pi_transcript_${hash("/some/sess.json")}`);
});

test("resolveContextKeys: empty identity yields no candidates", () => {
  assert.deepEqual(resolveContextKeys({}), []);
});

test("findTrellisRoot walks up from nested cwd", () => {
  const root = tmpRepo();
  mkdirSync(join(root, ".trellis"), { recursive: true });
  mkdirSync(join(root, "apps", "backend"), { recursive: true });
  assert.equal(findTrellisRoot(join(root, "apps", "backend")), root);
  assert.equal(findTrellisRoot(root), root);
  rmSync(root, { recursive: true, force: true });
});

test("findTrellisRoot ignores .pi-only and non-Trellis dirs", () => {
  const root = tmpRepo();
  mkdirSync(join(root, ".pi"), { recursive: true });
  assert.equal(findTrellisRoot(root), null);
  assert.deepEqual(findTrellisRoots(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("findTrellisRoots returns nearest cwd root through outer workspace root", () => {
  const workspace = tmpRepo();
  mkdirSync(join(workspace, ".trellis", "tasks"), { recursive: true });
  const child = join(workspace, "platform", "repo-a");
  mkdirSync(join(child, ".trellis", "tasks"), { recursive: true });
  const business = join(child, "src", "feature");
  mkdirSync(business, { recursive: true });
  assert.deepEqual(findTrellisRoots(business), [child, workspace]);
  assert.deepEqual(findTrellisRoots(child), [child, workspace]);
  assert.deepEqual(findTrellisRoots(workspace), [workspace]);
  rmSync(workspace, { recursive: true, force: true });
});

test("findTrellisRoots does not follow cwd symlink into an unrelated outer root", () => {
  const workspace = tmpRepo();
  const outside = tmpRepo();
  mkdirSync(join(workspace, ".trellis", "tasks"), { recursive: true });
  mkdirSync(join(outside, ".trellis", "tasks"), { recursive: true });
  const link = join(workspace, "linked-outside");
  let linked = false;
  try { symlinkSync(outside, link, "dir"); linked = true; } catch { /* unsupported */ }
  if (linked) assert.deepEqual(findTrellisRoots(link), [outside]);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("isPathInside uses path-relative semantics", () => {
  assert.equal(isPathInside("/a/b", "/a/b/c"), true);
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/bc"), false);
  assert.equal(isPathInside("/a/b", "/a/b/../c"), false);
  assert.equal(isPathInside("/a/b", "/a/c"), false);
});

test("loadSnapshot: false on untrusted", () => {
  const root = tmpRepo();
  writeTask(root, "t1", "in_progress", "- [ ] a\n");
  const snap = loadSnapshot(root, { sessionId: "s1" }, false);
  assert.equal(snap.available, false);
  assert.equal(snap.reason, "untrusted");
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: false on non-Trellis", () => {
  const root = tmpRepo();
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.available, false);
  assert.equal(snap.reason, "not-trellis");
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: reads current task from runtime session", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "## Checklist\n\n- [ ] a\n- [x] b\n");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.available, true);
  assert.equal(snap.degraded, false);
  assert.equal(snap.taskId, "T1");
  assert.equal(snap.statusRaw, "in_progress");
  assert.equal(snap.planning, false);
  assert.equal(snap.checklist?.mode, "checkbox");
  assert.equal(snap.checklist?.completed, 1);
  assert.equal(snap.checklist?.total, 2);
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: sole-session fallback when candidate keys miss", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "planning", "## Checklist\n\n- [ ] a\n");
  writeSession(root, "pi_other", ".trellis/tasks/T1");
  const snap = loadSnapshot(root, { sessionId: "missing" }, true);
  assert.equal(snap.available, true);
  assert.equal(snap.sourceType, "session-fallback");
  assert.equal(snap.taskId, "T1");
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: ambiguous (multiple) sessions never guessed", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "- [ ] a\n");
  writeTask(root, "T2", "in_progress", "- [ ] a\n");
  writeSession(root, "sA", ".trellis/tasks/T1");
  writeSession(root, "sB", ".trellis/tasks/T2");
  const snap = loadSnapshot(root, { sessionId: "missing-two" }, true);
  assert.equal(snap.available, false);
  assert.equal(snap.degraded, true);
  assert.equal(snap.reason, "no-session");
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: planning does not parse execution progress", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "planning", "## Checklist\n\n- [x] a\n- [ ] b\n");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.planning, true);
  assert.equal(snap.checklist, null);
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: legacy numbered plan preserved read-only", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "## Checklist\n\n1. one\n2. two\n");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.checklist?.mode, "legacy");
  assert.equal(snap.checklist?.progressAvailable, false);
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: bad JSON degrades, not crashes", () => {
  const root = tmpRepo();
  const dir = join(root, ".trellis", "tasks", "T1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), "{ not json", "utf8");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.available, false);
  assert.equal(snap.degraded, true);
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: ref escaping .trellis/tasks degrades", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "- [ ] a\n");
  writeSession(root, "pi_s1", "../outside");
  const snap = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.equal(snap.degraded, true);
  assert.ok(["bad-task-ref", "task-outside-tasks", "missing-task-dir"].includes(snap.reason ?? ""));
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: session directory symlink escape degrades (when symlinks supported)", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "- [ ] a\n");
  const outside = mkdtempSync(join(tmpdir(), "ttb-sessions-out-"));
  const runtime = join(root, ".trellis", ".runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(outside, "pi_s1.json"), JSON.stringify({ current_task: ".trellis/tasks/T1" }), "utf8");
  let linked = false;
  try {
    symlinkSync(outside, join(runtime, "sessions"), "dir");
    linked = true;
  } catch {
    /* symlinks unsupported on this host */
  }
  if (linked) {
    const snapshot = loadSnapshot(root, { sessionId: "s1" }, true);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.reason, "session-outside-root");
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("loadSnapshot: task.json and implement.md symlink escapes are not read", () => {
  const root = tmpRepo();
  const taskDir = writeTask(root, "T1", "in_progress", "- [ ] safe\n");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const outside = mkdtempSync(join(tmpdir(), "ttb-task-files-out-"));
  writeFileSync(join(outside, "task.json"), JSON.stringify({ id: "EVIL", status: "in_progress" }), "utf8");
  writeFileSync(join(outside, "implement.md"), "- [ ] escaped\n", "utf8");
  let linked = false;
  try {
    rmSync(join(taskDir, "task.json"));
    rmSync(join(taskDir, "implement.md"));
    symlinkSync(join(outside, "task.json"), join(taskDir, "task.json"), "file");
    symlinkSync(join(outside, "implement.md"), join(taskDir, "implement.md"), "file");
    linked = true;
  } catch {
    /* symlinks unsupported on this host */
  }
  if (linked) {
    const snapshot = loadSnapshot(root, { sessionId: "s1" }, true);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.reason, "bad-task-json");
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("loadSnapshot: symlink escape from tasks degrades (when symlinks supported)", () => {
  const root = tmpRepo();
  const outside = mkdtempSync(join(tmpdir(), "ttb-out-"));
  writeFileSync(join(outside, "task.json"), JSON.stringify({ id: "evil", status: "in_progress" }), "utf8");
  const tasksLink = join(root, ".trellis", "tasks");
  mkdirSync(join(root, ".trellis"), { recursive: true });
  let linked = false;
  try {
    symlinkSync(outside, tasksLink, "dir");
    linked = true;
  } catch {
    /* symlinks unsupported on this host */
  }
  if (linked) {
    writeSession(root, "pi_s1", ".trellis/tasks/evil");
    const snap = loadSnapshot(root, { sessionId: "s1" }, true);
    assert.equal(snap.available, false);
    assert.equal(snap.degraded, true);
  }
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: planning material changes update the fingerprint", () => {
  const root = tmpRepo();
  const taskDir = writeTask(root, "T1", "planning", "## Checklist\n\n- [ ] a\n");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap1 = loadSnapshot(root, { sessionId: "s1" }, true);
  writeFileSync(join(taskDir, "prd.md"), "# Requirements\n", "utf8");
  const snap2 = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.notEqual(snap1.fingerprint, snap2.fingerprint);
  rmSync(root, { recursive: true, force: true });
});

test("loadSnapshot: fingerprint changes when current task content changes", () => {
  const root = tmpRepo();
  writeTask(root, "T1", "in_progress", "- [ ] a\n");
  const s1 = writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const snap1 = loadSnapshot(root, { sessionId: "s1" }, true);
  writeSession(root, "pi_other", ".trellis/tasks/T1");
  writeFileSync(join(root, ".trellis", "tasks", "T1", "implement.md"), "- [x] a\n", "utf8");
  const snap2 = loadSnapshot(root, { sessionId: "s1" }, true);
  assert.notEqual(snap1.fingerprint, snap2.fingerprint);
  void s1;
  rmSync(root, { recursive: true, force: true });
});