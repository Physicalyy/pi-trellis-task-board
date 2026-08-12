import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildWorkspaceLinks,
  discoverNestedTrellisRoots,
  discoverOwnerRepositories,
  isAggregate,
  loadBoard,
  loadWritableSnapshot,
  mergeRepositorySources,
  parseConfigState,
  readRepositorySnapshot,
  sortRepositories,
  type PackageConfig,
} from "../extensions/trellis-task-board/aggregate-state.ts";

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ttb-agg-"));
  mkdirSync(join(root, ".trellis", "tasks"), { recursive: true });
  return root;
}

function writeConfig(root: string, yamlBody: string): void {
  writeFileSync(join(root, ".trellis", "config.yaml"), yamlBody, "utf8");
}

function writeSession(root: string, key: string, ref: string): void {
  const dir = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${key}.json`),
    JSON.stringify({ platform: "pi", current_task: ref, current_run: null }),
    "utf8",
  );
}

function writeTask(
  root: string,
  name: string,
  status: string,
  opts: { meta?: Record<string, unknown>; children?: string[]; implement?: string } = {},
): string {
  const dir = join(root, ".trellis", "tasks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "task.json"),
    JSON.stringify({ id: name, title: `Title ${name}`, status, children: opts.children ?? [], meta: opts.meta ?? {} }),
    "utf8",
  );
  if (opts.implement !== undefined) writeFileSync(join(dir, "implement.md"), opts.implement, "utf8");
  return dir;
}

function makeRepo(root: string, rel: string): string {
  const dir = join(root, rel);
  mkdirSync(join(dir, ".trellis", "tasks"), { recursive: true });
  return dir;
}

function writeRepoTask(
  repo: string,
  name: string,
  status: string,
  opts: { implement?: string } = {},
): string {
  const dir = join(repo, ".trellis", "tasks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify({ id: name, title: `Repo ${name}`, status }), "utf8");
  if (opts.implement !== undefined) writeFileSync(join(dir, "implement.md"), opts.implement, "utf8");
  return dir;
}

function configuredPkg(root: string, name: string, rel: string): PackageConfig {
  return { name, rawPath: rel, path: join(root, rel), realPath: join(root, rel) };
}

function cleanup(...roots: string[]): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

// ── Config classification ───────────────────────────────────────────────

test("parseConfigState: missing config.yaml is unconfigured", () => {
  const root = tmpRoot();
  assert.equal(parseConfigState(root).kind, "unconfigured");
  cleanup(root);
});

test("parseConfigState: config without packages is unconfigured", () => {
  const root = tmpRoot();
  writeConfig(root, "session_auto_commit: false\n");
  assert.equal(parseConfigState(root).kind, "unconfigured");
  cleanup(root);
});

test("parseConfigState: empty packages map is unconfigured", () => {
  const root = tmpRoot();
  writeConfig(root, "packages: {}\n");
  assert.equal(parseConfigState(root).kind, "unconfigured");
  cleanup(root);
});

test("parseConfigState: config.yaml symlink escape is rejected", () => {
  const root = tmpRoot();
  const outside = mkdtempSync(join(tmpdir(), "ttb-config-out-"));
  const outsideConfig = join(outside, "config.yaml");
  writeFileSync(outsideConfig, "packages: {}\n", "utf8");
  let linked = false;
  try {
    symlinkSync(outsideConfig, join(root, ".trellis", "config.yaml"), "file");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    const state = parseConfigState(root);
    assert.equal(state.kind, "invalid");
    if (state.kind === "invalid") assert.ok(state.diagnostics.some((diagnostic) => diagnostic.code === "config-path-unsafe"));
  }
  cleanup(root, outside);
});

test("parseConfigState: unparseable YAML is invalid with a diagnostic", () => {
  const root = tmpRoot();
  writeConfig(root, "packages: [unclosed\n  broken: :\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "invalid");
  if (state.kind === "invalid") {
    assert.ok(state.diagnostics.some((d) => d.code === "config-yaml-parse"));
  }
  cleanup(root);
});

test("parseConfigState: malformed packages type is invalid", () => {
  const root = tmpRoot();
  writeConfig(root, "packages: just-a-string\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "invalid");
  if (state.kind === "invalid") {
    assert.ok(state.diagnostics.some((d) => d.code === "config-packages-type"));
  }
  cleanup(root);
});

test("parseConfigState: all-invalid packages degrades with per-entry diagnostics", () => {
  const root = tmpRoot();
  writeConfig(root, "packages:\n  a:\n    path: /absolute/path\n  b:\n    path: does-not-exist\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "invalid");
  if (state.kind === "invalid") {
    assert.ok(state.diagnostics.some((d) => d.code === "package-path-absolute"));
    assert.ok(state.diagnostics.some((d) => d.code === "package-path-missing"));
  }
  cleanup(root);
});

// ── Package validation ──────────────────────────────────────────────────

test("parseConfigState: valid package is configured and canonicalized", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeConfig(root, "packages:\n  repo-a:\n    path: platform/repo-a\n    git: true\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "configured");
  if (state.kind === "configured") {
    assert.equal(state.packages.length, 1);
    assert.equal(state.packages[0].realPath, repo);
    assert.equal(state.diagnostics.length, 0);
  }
  cleanup(root);
});

test("parseConfigState: absolute path is rejected", () => {
  const root = tmpRoot();
  writeConfig(root, `packages:\n  a:\n    path: ${join(tmpdir(), "elsewhere")}\n`);
  const state = parseConfigState(root);
  assert.equal(state.kind, "invalid");
  if (state.kind === "invalid") {
    assert.ok(state.diagnostics.some((d) => d.code === "package-path-absolute"));
  }
  cleanup(root);
});

test("parseConfigState: path escaping the workspace root is rejected (package-outside-root)", () => {
  const root = tmpRoot();
  const outside = mkdtempSync(join(tmpdir(), "ttb-out-"));

  // Prefer an inside-root symlink whose realpath lands outside the root; if
  // the platform does not allow symlinks, fall back to a real existing sibling
  // directory referenced through `..` (still an escape from root). Both must be
  // rejected as package-outside-root.
  const link = join(root, "escape-link");
  let ref = "";
  let usedLink = false;
  try {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(outside, link, "dir");
    ref = "escape-link";
    usedLink = true;
  } catch {
    ref = `../${basename(outside)}`;
  }

  try {
    writeConfig(root, `packages:\n  esc:\n    path: ${ref}\n`);
    const state = parseConfigState(root);
    assert.equal(state.kind, "invalid");
    if (state.kind === "invalid") {
      assert.ok(
        state.diagnostics.some((d) => d.code === "package-outside-root"),
        "an escaping package must be rejected as package-outside-root",
      );
    }
  } finally {
    if (usedLink) rmSync(link, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    cleanup(root);
  }
});

test("parseConfigState: self-reference to workspace root is rejected", () => {
  const root = tmpRoot();
  writeConfig(root, "packages:\n  me:\n    path: .\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "invalid");
  if (state.kind === "invalid") {
    assert.ok(state.diagnostics.some((d) => d.code === "package-self-reference"));
  }
  cleanup(root);
});

test("parseConfigState: canonical duplicate packages are deduplicated", () => {
  const root = tmpRoot();
  makeRepo(root, "platform/repo-a");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n  b:\n    path: platform/./repo-a\n");
  const state = parseConfigState(root);
  assert.equal(state.kind, "configured");
  if (state.kind === "configured") {
    assert.equal(state.packages.length, 1);
    assert.ok(state.diagnostics.some((d) => d.code === "package-duplicate"));
  }
  cleanup(root);
});

// ── Repository enumeration ──────────────────────────────────────────────

test("readRepositorySnapshot: counts lifecycle statuses and excludes archive", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-01-task", "in_progress", { implement: "## Checklist\n\n- [ ] a\n- [x] b\n" });
  writeRepoTask(repo, "08-02-task", "completed");
  writeRepoTask(repo, "08-03-task", "planning");
  writeRepoTask(repo, "08-04-task", "review");
  writeRepoTask(repo, "08-05-task", "weird-status");
  writeRepoTask(repo, "08-06-task", "completed");
  mkdirSync(join(repo, ".trellis", "tasks", "archive"), { recursive: true });
  writeRepoTask(join(repo, ".trellis", "tasks", "archive"), "09-99-archived", "in_progress");

  const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  assert.equal(snap.counts.total, 6);
  assert.equal(snap.counts.completed, 2);
  assert.equal(snap.counts.inProgress, 1);
  assert.equal(snap.counts.planning, 1);
  assert.equal(snap.counts.review, 1);
  assert.equal(snap.counts.unknown, 1);
  assert.equal(snap.tasks.some((t) => t.taskId === "09-99-archived"), false);
  // completed-but-not-archived tasks are included.
  assert.equal(snap.tasks.filter((t) => t.statusRaw === "completed").length, 2);
  cleanup(root);
});

test("readRepositorySnapshot: stable sort by status then dir name descending", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-02-task", "planning");
  writeRepoTask(repo, "08-01-task", "in_progress");
  writeRepoTask(repo, "08-03-task", "completed");
  writeRepoTask(repo, "08-04-task", "in_progress");
  const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  const ids = snap.tasks.map((t) => t.taskId);
  assert.deepEqual(ids, ["08-04-task", "08-01-task", "08-02-task", "08-03-task"]);
  cleanup(root);
});

test("readRepositorySnapshot: malformed task JSON is a local warning, not a crash", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-01-task", "in_progress");
  const bad = join(repo, ".trellis", "tasks", "08-02-bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "task.json"), "{ nope", "utf8");
  const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  assert.equal(snap.counts.total, 1);
  assert.ok(snap.warnings.some((w) => w.code === "task-json-invalid"));
  cleanup(root);
});

test("readRepositorySnapshot: missing .trellis and missing tasks are local warnings", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  rmSync(join(repo, ".trellis", "tasks"), { recursive: true, force: true });
  const noTasks = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  assert.equal(noTasks.counts.total, 0);
  assert.ok(noTasks.warnings.some((w) => w.code === "repo-no-tasks"));

  rmSync(join(repo, ".trellis"), { recursive: true, force: true });
  const noTrellis = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  assert.equal(noTrellis.counts.total, 0);
  assert.ok(noTrellis.warnings.some((w) => w.code === "repo-no-trellis"));
  cleanup(root);
});

test("readRepositorySnapshot: checklist modes checkbox/legacy/none", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "t-cb", "in_progress", { implement: "## Checklist\n\n- [x] a\n- [ ] b\n" });
  writeRepoTask(repo, "t-legacy", "in_progress", { implement: "## Checklist\n\n1. one\n2. two\n" });
  writeRepoTask(repo, "t-none", "in_progress", { implement: "no checklist here\n" });
  const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  const cb = snap.tasks.find((t) => t.taskId === "t-cb")!;
  const legacy = snap.tasks.find((t) => t.taskId === "t-legacy")!;
  const none = snap.tasks.find((t) => t.taskId === "t-none")!;
  assert.equal(cb.checklist?.mode, "checkbox");
  assert.equal(cb.checklist?.completed, 1);
  assert.equal(cb.checklist?.total, 2);
  assert.equal(legacy.checklist?.mode, "legacy");
  assert.equal(legacy.checklist?.progressAvailable, false);
  assert.equal(none.checklist?.mode, "none");
  cleanup(root);
});

test("readRepositorySnapshot: implement.md symlink escape is not parsed", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  const taskDir = writeRepoTask(repo, "t-cb", "in_progress");
  const outside = mkdtempSync(join(tmpdir(), "ttb-implement-out-"));
  const outsideImplement = join(outside, "implement.md");
  writeFileSync(outsideImplement, "- [ ] escaped\n", "utf8");
  let linked = false;
  try {
    symlinkSync(outsideImplement, join(taskDir, "implement.md"), "file");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    const snapshot = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
    assert.equal(snapshot.tasks[0].checklist, null);
  }
  cleanup(root, outside);
});

test("readRepositorySnapshot: planning tasks never parse a checklist", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "t-plan", "planning", { implement: "## Checklist\n\n- [x] a\n" });
  const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
  const plan = snap.tasks.find((t) => t.taskId === "t-plan")!;
  assert.equal(plan.planning, true);
  assert.equal(plan.checklist, null);
  cleanup(root);
});

test("readRepositorySnapshot: symlink escape from tasks is a warning", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  const outside = mkdtempSync(join(tmpdir(), "ttb-out-"));
  const link = join(repo, ".trellis", "tasks", "evil");
  let linked = false;
  try {
    symlinkSync(outside, link, "dir");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    writeFileSync(join(outside, "task.json"), JSON.stringify({ id: "evil", status: "in_progress" }), "utf8");
    const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
    assert.equal(snap.counts.total, 0);
    assert.ok(snap.warnings.some((w) => w.code === "task-outside-tasks"));
  }
  rmSync(outside, { recursive: true, force: true });
  cleanup(root);
});

test("readRepositorySnapshot: .trellis symlink escaping the package is a warning", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  const outside = mkdtempSync(join(tmpdir(), "ttb-out-"));
  rmSync(join(repo, ".trellis"), { recursive: true, force: true });
  let linked = false;
  try {
    symlinkSync(outside, join(repo, ".trellis"), "dir");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    writeFileSync(join(outside, "task.json"), JSON.stringify({ id: "x", status: "in_progress" }), "utf8");
    const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
    assert.equal(snap.counts.total, 0);
    assert.ok(snap.warnings.some((w) => w.code === "repo-trellis-escape"));
  }
  rmSync(outside, { recursive: true, force: true });
  cleanup(root);
});

test("readRepositorySnapshot: .trellis/tasks symlink escaping the package is a warning", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  const outside = mkdtempSync(join(tmpdir(), "ttb-out-"));
  rmSync(join(repo, ".trellis", "tasks"), { recursive: true, force: true });
  let linked = false;
  try {
    symlinkSync(outside, join(repo, ".trellis", "tasks"), "dir");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    writeFileSync(join(outside, "task.json"), JSON.stringify({ id: "x", status: "in_progress" }), "utf8");
    const snap = readRepositorySnapshot(configuredPkg(root, "a", "platform/repo-a"));
    assert.equal(snap.counts.total, 0);
    assert.ok(snap.warnings.some((w) => w.code === "repo-tasks-escape"));
  }
  rmSync(outside, { recursive: true, force: true });
  cleanup(root);
});

test("sortRepositories: in-progress repos come first, config order kept within", () => {
  const mk = (name: string, inProgress: number): ReturnType<typeof readRepositorySnapshot> =>
    ({
      packageName: name,
      relativePath: name,
      root: name,
      tasks: [],
      counts: { total: 0, completed: 0, inProgress, planning: 0, review: 0, unknown: 0 },
      warnings: [],
    }) as ReturnType<typeof readRepositorySnapshot>;
  const repos = [mk("z-repo", 0), mk("a-repo", 1), mk("m-repo", 0)];
  const sorted = sortRepositories(repos);
  assert.deepEqual(sorted.map((r) => r.packageName), ["a-repo", "z-repo", "m-repo"]);
});

// ── Automatic discovery ─────────────────────────────────────────────────

test("discoverNestedTrellisRoots finds nested roots without packages and skips management/build dirs", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  const repoB = makeRepo(root, "services/repo-b");
  makeRepo(root, "node_modules/ignored");
  makeRepo(root, "dist/ignored");
  const result = discoverNestedTrellisRoots(root);
  assert.deepEqual(result.packages.map((pkg) => pkg.realPath).sort(), [repoA, repoB].sort());
  assert.equal(result.packages.some((pkg) => pkg.rawPath.includes("ignored")), false);
  cleanup(root);
});

test("discoverNestedTrellisRoots reports budget exhaustion and does not traverse outside symlinks", () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  for (let index = 0; index < 8; index++) mkdirSync(join(root, `dir-${index}`), { recursive: true });
  const link = join(root, "external-link");
  let linked = false;
  try { symlinkSync(outside, link, "dir"); linked = true; } catch { /* unsupported */ }
  const result = discoverNestedTrellisRoots(root, { maxDirectories: 2, maxDepth: 8 });
  assert.ok(result.diagnostics.some((warning) => warning.code === "discovery-budget"));
  if (linked) assert.ok(result.diagnostics.some((warning) => warning.code === "discovery-symlink-escape"));
  assert.equal(result.packages.some((pkg) => pkg.realPath === outside), false);
  cleanup(root, outside);
});

test("mergeRepositorySources preserves explicit package name and realpath-deduplicates", () => {
  const explicit: PackageConfig = { name: "friendly", rawPath: "repo", path: "/ws/repo", realPath: "/ws/repo", source: "package" };
  const discovered: PackageConfig = { name: "repo", rawPath: "repo", path: "/ws/repo", realPath: "/ws/repo", source: "discovered" };
  const merged = mergeRepositorySources([explicit], [], [discovered]);
  assert.equal(merged.packages.length, 1);
  assert.equal(merged.packages[0].name, "friendly");
  assert.equal(merged.packages[0].source, "package");
});

test("discoverOwnerRepositories rejects a task directory symlink escape and keeps safe tasks", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeTask(root, "WS", "in_progress", { meta: { "owner-repo": "platform/repo-a" } });
  const outside = tmpRoot();
  mkdirSync(join(outside, ".trellis", "tasks"), { recursive: true });
  const escaped = join(outside, "escaped-task");
  mkdirSync(escaped, { recursive: true });
  writeFileSync(join(escaped, "task.json"), JSON.stringify({ id: "EVIL", status: "in_progress", meta: { "owner-repo": "platform/repo-a" } }), "utf8");
  let linked = false;
  try {
    symlinkSync(escaped, join(root, ".trellis", "tasks", "escaped"), "dir");
    linked = true;
  } catch {
    /* symlinks unsupported */
  }
  if (linked) {
    const result = discoverOwnerRepositories(root);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].realPath, repo);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "owner-task-escape"));
  }
  cleanup(root, outside);
});

// ── Aggregate board loading ─────────────────────────────────────────────

test("loadBoard: unconfigured root returns the plain single-root snapshot", () => {
  const root = tmpRoot();
  writeTask(root, "T1", "in_progress", { implement: "- [ ] a\n" });
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), false);
  if (isAggregate(view)) return;
  assert.equal(view.available, true);
  assert.equal(view.taskId, "T1");
  cleanup(root);
});

test("loadBoard: untrusted and non-Trellis stay quietly inactive", () => {
  const root = tmpRoot();
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  const untrusted = loadBoard(root, { sessionId: "s1" }, false);
  assert.equal(isAggregate(untrusted), false);
  if (isAggregate(untrusted)) return;
  assert.equal(untrusted.available, false);
  assert.equal(untrusted.reason, "untrusted");

  const nonTrellis = mkdtempSync(join(tmpdir(), "ttb-non-"));
  const nt = loadBoard(nonTrellis, { sessionId: "s1" }, true);
  assert.equal(isAggregate(nt), false);
  if (isAggregate(nt)) return;
  assert.equal(nt.available, false);
  assert.equal(nt.reason, "not-trellis");
  cleanup(root, nonTrellis);
});

test("loadBoard: no packages automatically aggregates nested roots from root, child and business cwd", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  const repoB = makeRepo(root, "services/repo-b");
  writeRepoTask(repoA, "A", "in_progress", { implement: "- [ ] a\n" });
  writeRepoTask(repoB, "B", "planning");
  const business = join(repoA, "src", "feature");
  mkdirSync(business, { recursive: true });
  for (const cwd of [root, repoA, business]) {
    const view = loadBoard(cwd, { sessionId: "fresh" }, true);
    assert.equal(isAggregate(view), true);
    if (!isAggregate(view)) continue;
    assert.equal(view.root, root);
    assert.equal(view.cwdRoot, cwd === root ? root : repoA);
    assert.deepEqual(view.repositories.map((repo) => repo.root).sort(), [repoA, repoB].sort());
    assert.equal(view.activeBinding?.kind, "unbound");
  }
  cleanup(root);
});

test("loadBoard: unique child session binding is separate from workspace lifecycle", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "A", "in_progress", { implement: "- [ ] child item\n" });
  writeTask(root, "WS", "in_progress", { implement: "- [ ] workspace item\n" });
  writeSession(root, "pi_old", ".trellis/tasks/WS");
  writeSession(repo, "pi_s1", ".trellis/tasks/A");
  const view = loadBoard(join(repo, "src"), { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.workspace.available, false, "old root session must not impersonate current session");
  assert.equal(view.activeBinding?.kind, "bound");
  if (view.activeBinding?.kind === "bound") {
    assert.equal(view.activeBinding.snapshot.taskId, "A");
    assert.equal(view.activeBinding.repository?.root, repo);
  }
  cleanup(root);
});

test("loadBoard: same identity bound in multiple roots is ambiguous and writable resolution fails closed", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeTask(root, "WS", "in_progress", { implement: "- [ ] root\n" });
  writeRepoTask(repo, "A", "in_progress", { implement: "- [ ] child\n" });
  writeSession(root, "pi_s1", ".trellis/tasks/WS");
  writeSession(repo, "pi_s1", ".trellis/tasks/A");
  const view = loadBoard(repo, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.activeBinding?.kind, "ambiguous");
  assert.ok(view.warnings.some((warning) => warning.code === "active-binding-ambiguous"));
  const writable = loadWritableSnapshot(repo, { sessionId: "s1" }, true);
  assert.equal(writable.available, false);
  assert.equal(writable.reason, "ambiguous-active-binding");
  cleanup(root);
});

test("loadBoard: aggregates two valid packages with workspace current task", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  const repoB = makeRepo(root, "services/repo-b");
  writeRepoTask(repoA, "08-01-task", "in_progress", { implement: "- [ ] a\n" });
  writeRepoTask(repoA, "08-02-task", "completed");
  writeRepoTask(repoB, "08-03-task", "planning");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n  b:\n    path: services/repo-b\n");
  writeTask(root, "T1", "in_progress", { implement: "- [ ] x\n" });
  writeSession(root, "pi_s1", ".trellis/tasks/T1");

  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.workspace.available, true);
  assert.equal(view.repositories.length, 2);
  assert.equal(view.repositories[0].counts.total, 2);
  assert.equal(view.repositories[1].counts.total, 1);
  assert.equal(view.configState.kind, "configured");
  cleanup(root);
});

test("loadBoard: no workspace session but packages still aggregate", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  writeRepoTask(repoA, "08-01-task", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.workspace.available, false);
  assert.equal(view.workspace.degraded, true);
  assert.equal(view.workspace.reason, "no-session");
  assert.equal(view.repositories.length, 1);
  cleanup(root);
});

test("loadBoard: explicit but invalid packages keeps diagnostics (not silent single-root)", () => {
  const root = tmpRoot();
  writeTask(root, "T1", "in_progress");
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  writeConfig(root, "packages:\n  a:\n    path: /absolute/path\n");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.configState.kind, "invalid");
  assert.equal(view.repositories.length, 0);
  assert.ok(view.warnings.some((w) => w.code === "package-path-absolute"));
  assert.equal(view.workspace.available, true, "root task is still shown");
  cleanup(root);
});

test("loadBoard: one invalid package does not hide valid repositories", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  writeRepoTask(repoA, "08-01-task", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n  bad:\n    path: missing-dir\n");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.configState.kind, "configured");
  assert.equal(view.repositories.length, 1);
  assert.ok(view.warnings.some((w) => w.code === "package-path-missing"));
  cleanup(root);
});

test("aggregate fingerprint changes when discovered repository set changes", () => {
  const root = tmpRoot();
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "A", "planning");
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), false);
  assert.equal(isAggregate(v2), true);
  if (isAggregate(v2)) assert.equal(v2.repositories.some((repository) => repository.root === repo), true);
  cleanup(root);
});

test("aggregate fingerprint changes when an explicit session binding changes", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "A", "in_progress", { implement: "- [ ] a\n" });
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  writeSession(repo, "pi_s1", ".trellis/tasks/A");
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), true);
  assert.equal(isAggregate(v2), true);
  if (isAggregate(v1) && isAggregate(v2)) {
    assert.equal(v1.activeBinding?.kind, "unbound");
    assert.equal(v2.activeBinding?.kind, "bound");
    assert.notEqual(v1.fingerprint, v2.fingerprint);
  }
  cleanup(root);
});

test("aggregate fingerprint changes when repo task content changes", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  const dir = writeRepoTask(repoA, "08-01-task", "in_progress", { implement: "- [ ] a\n" });
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  writeFileSync(join(dir, "implement.md"), "- [x] a\n", "utf8");
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), true);
  assert.equal(isAggregate(v2), true);
  if (isAggregate(v1) && isAggregate(v2)) {
    assert.notEqual(v1.fingerprint, v2.fingerprint);
  }
  cleanup(root);
});

test("aggregate fingerprint changes when config.yaml changes", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  writeRepoTask(repoA, "08-01-task", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n  b:\n    path: platform/other\n");
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), true);
  assert.equal(isAggregate(v2), true);
  if (isAggregate(v1) && isAggregate(v2)) {
    assert.notEqual(v1.fingerprint, v2.fingerprint);
  }
  cleanup(root);
});

test("aggregate fingerprint changes when a repository gains a warning with zero tasks", () => {
  const root = tmpRoot();
  const repoA = makeRepo(root, "platform/repo-a");
  writeRepoTask(repoA, "08-01-task", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  // Remove the tasks dir: zero tasks but the repo gains a repo-no-tasks warning.
  rmSync(join(repoA, ".trellis", "tasks"), { recursive: true, force: true });
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), true);
  assert.equal(isAggregate(v2), true);
  if (isAggregate(v1) && isAggregate(v2)) {
    assert.ok(v1.repositories[0].counts.total > 0);
    assert.equal(v2.repositories[0].counts.total, 0);
    assert.ok(v2.repositories[0].warnings.some((w) => w.code === "repo-no-tasks"));
    assert.notEqual(v1.fingerprint, v2.fingerprint, "repo counts/warnings must drive the fingerprint");
  }
  cleanup(root);
});

test("aggregate fingerprint changes when a linked child's status changes (mismatch persists)", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-01-child", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  // Workspace current task has an active direct child that maps to the repo task.
  writeTask(root, "T1", "in_progress", { children: ["child-a"], implement: "- [ ] x\n" });
  const childA = join(root, ".trellis", "tasks", "child-a");
  mkdirSync(childA, { recursive: true });
  writeFileSync(
    join(childA, "task.json"),
    JSON.stringify({
      id: "child-a",
      title: "Child A",
      status: "in_progress",
      meta: { "owner-repo": "platform/repo-a", "local-task": "08-01-child" },
    }),
    "utf8",
  );
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const v1 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v1), true);
  if (!isAggregate(v1)) return;
  const l1 = v1.links.find((l) => l.workspaceTaskId === "child-a");
  assert.ok(l1);
  assert.equal(l1.statusMatches, true);

  // Change only the child's status: the workspace current task and the repo
  // task files are untouched, so only the link outcome can drive the refresh.
  writeFileSync(
    join(childA, "task.json"),
    JSON.stringify({
      id: "child-a",
      title: "Child A",
      status: "planning",
      meta: { "owner-repo": "platform/repo-a", "local-task": "08-01-child" },
    }),
    "utf8",
  );
  const v2 = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(v2), true);
  if (!isAggregate(v2)) return;
  const l2 = v2.links.find((l) => l.workspaceTaskId === "child-a");
  assert.ok(l2);
  assert.equal(l2.statusMatches, false, "mismatch persists after the change");
  assert.notEqual(l1.workspaceStatus, l2.workspaceStatus);
  assert.notEqual(v1.fingerprint, v2.fingerprint, "link workspace status must drive the fingerprint");
  cleanup(root);
});

// ── Workspace mapping ───────────────────────────────────────────────────

function aggregateWithWorkspace(opts: {
  workspaceMeta?: Record<string, unknown>;
  children?: string[];
  repo?: string;
  localTaskName?: string;
  localStatus?: string;
}): ReturnType<typeof loadBoard> {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  if (opts.repo && opts.localTaskName) {
    writeRepoTask(repo, opts.localTaskName, opts.localStatus ?? "in_progress", { implement: "- [ ] a\n" });
  }
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  writeTask(root, "T1", "in_progress", {
    meta: opts.workspaceMeta,
    children: opts.children ?? [],
    implement: "- [ ] x\n",
  });
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  return loadBoard(root, { sessionId: "s1" }, true);
}

test("mapping: current task owner-repo + local-task links successfully", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "platform/repo-a", "local-task": "08-01-task" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
    localStatus: "in_progress",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 1);
  const link = view.links[0];
  assert.equal(link.ownerRepo, "platform/repo-a");
  assert.equal(link.localTask, "08-01-task");
  assert.equal(link.repositoryTask?.taskId, "08-01-task");
  assert.equal(link.statusMatches, true);
  cleanup(boardRoot(view));
});

test("mapping: status difference is reported without syncing", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "platform/repo-a", "local-task": "08-01-task" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
    localStatus: "completed",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  const link = view.links[0];
  assert.equal(link.statusMatches, false);
  assert.equal(link.workspaceStatus, "in_progress");
  assert.equal(link.repositoryTask?.statusRaw, "completed");
  cleanup(boardRoot(view));
});

test("mapping: archive-prefixed child ref is rejected before resolving an archived root task", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-01-child", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  writeTask(root, "T1", "in_progress", {
    children: ["archive/2026-08/old-task"],
    implement: "- [ ] x\n",
  });
  // An archived root task genuinely exists under .trellis/tasks/archive/... and
  // carries mapping meta that WOULD link if the unsafe child ref were resolved
  // (it is canonically inside the tasks dir, so only the pre-resolve check stops it).
  const arch = join(root, ".trellis", "tasks", "archive", "2026-08", "old-task");
  mkdirSync(arch, { recursive: true });
  writeFileSync(
    join(arch, "task.json"),
    JSON.stringify({
      id: "old-task",
      status: "in_progress",
      meta: { "owner-repo": "platform/repo-a", "local-task": "08-01-child" },
    }),
    "utf8",
  );
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  // The archive-prefixed child ref is unsafe and must never be linked.
  assert.equal(view.links.length, 0, "archive-prefixed child ref must not link an archived root task");
  cleanup(root);
});

test("mapping: active direct children are linked, archived children are not", () => {
  const root = tmpRoot();
  const repo = makeRepo(root, "platform/repo-a");
  writeRepoTask(repo, "08-01-child", "in_progress");
  writeConfig(root, "packages:\n  a:\n    path: platform/repo-a\n");
  writeTask(root, "T1", "in_progress", {
    children: ["child-a", "child-archived"],
    implement: "- [ ] x\n",
  });
  // child-a links to the repo task; child-archived lives under root archive.
  const childA = join(root, ".trellis", "tasks", "child-a");
  mkdirSync(childA, { recursive: true });
  writeFileSync(
    join(childA, "task.json"),
    JSON.stringify({ id: "child-a", status: "in_progress", meta: { "owner-repo": "platform/repo-a", "local-task": "08-01-child" } }),
    "utf8",
  );
  const arch = join(root, ".trellis", "tasks", "archive");
  mkdirSync(join(arch, "child-archived"), { recursive: true });
  writeFileSync(
    join(arch, "child-archived", "task.json"),
    JSON.stringify({ id: "child-archived", status: "in_progress", meta: { "owner-repo": "platform/repo-a", "local-task": "08-01-child" } }),
    "utf8",
  );
  writeSession(root, "pi_s1", ".trellis/tasks/T1");
  const view = loadBoard(root, { sessionId: "s1" }, true);
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  // Only the active child links; the archived child is skipped (missing via archive).
  assert.equal(view.links.some((l) => l.workspaceTaskId === "child-a"), true);
  assert.equal(view.links.some((l) => l.workspaceTaskId === "child-archived"), false);
  cleanup(root);
});

test("mapping: owner-repo not matching any configured package warns", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "services/unknown", "local-task": "08-01-task" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 1);
  assert.equal(view.links[0].repository, null);
  assert.ok(view.links[0].warning);
  cleanup(boardRoot(view));
});

test("mapping: missing local-task task warns without breaking the repo", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "platform/repo-a", "local-task": "08-99-missing" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  const link = view.links[0];
  assert.equal(link.repositoryTask, null);
  assert.ok(link.warning);
  assert.equal(view.repositories[0].counts.total, 1, "repo still enumerates its tasks");
  cleanup(boardRoot(view));
});

test("mapping: local-task path traversal is rejected", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "platform/repo-a", "local-task": "../outside" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  const link = view.links[0];
  assert.equal(link.repositoryTask, null);
  assert.ok(link.warning);
  cleanup(boardRoot(view));
});

test("mapping: no meta means no link but repo overview still works", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: {},
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 0);
  assert.equal(view.repositories[0].counts.total, 1);
  cleanup(boardRoot(view));
});

test("mapping: owner-repo present but local-task missing resolves the repo and warns", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "platform/repo-a" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 1);
  const link = view.links[0];
  assert.equal(link.repository?.relativePath, "platform/repo-a");
  assert.equal(link.repositoryTask, null);
  assert.equal(link.statusMatches, false);
  assert.ok(link.warning, "partial mapping must surface a diagnostic, not disappear");
  assert.match(link.warning, /local-task/);
  cleanup(boardRoot(view));
});

test("mapping: owner-repo present, local-task missing, unconfigured repo warns", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "owner-repo": "services/unknown" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 1);
  const link = view.links[0];
  assert.equal(link.repository, null);
  assert.equal(link.repositoryTask, null);
  assert.ok(link.warning);
  assert.match(link.warning, /未匹配/);
  cleanup(boardRoot(view));
});

test("mapping: local-task present without owner-repo warns", () => {
  const view = aggregateWithWorkspace({
    workspaceMeta: { "local-task": "08-01-task" },
    repo: "platform/repo-a",
    localTaskName: "08-01-task",
  });
  assert.equal(isAggregate(view), true);
  if (!isAggregate(view)) return;
  assert.equal(view.links.length, 1);
  const link = view.links[0];
  assert.equal(link.repository, null);
  assert.equal(link.repositoryTask, null);
  assert.equal(link.statusMatches, false);
  assert.ok(link.warning);
  assert.match(link.warning, /owner-repo/);
  cleanup(boardRoot(view));
});

function boardRoot(view: unknown): string {
  if (isAggregate(view as ReturnType<typeof loadBoard>)) {
    return (view as { root: string }).root;
  }
  return (view as { root?: string }).root ?? "";
}
