/**
 * Multi-root aggregate board state for trusted polyrepo workspaces.
 *
 * A workspace root Trellis may declare `packages` in `.trellis/config.yaml`.
 * This module reads only that explicit declaration (never a recursive scan)
 * and, for every valid package, enumerates its non-archived `.trellis/tasks/`
 * entries plus their lifecycle status and checklist progress. It also links
 * the workspace current task (and its active direct children) to repository
 * tasks through `meta.owner-repo` + `meta.local-task`, reporting status
 * differences without syncing anything.
 *
 * Everything here is read-only. The single write boundary stays in
 * mutation.ts and only ever targets the current Trellis root's current task.
 *
 * Configuration outcomes are deliberately distinct:
 *  - `unconfigured`: no `packages` key / empty map  -> plain single-root view.
 *  - `invalid`:      YAML unparseable or `packages` malformed / all entries
 *                    rejected -> aggregate-degraded view (root task kept,
 *                    per-entry diagnostics shown, never silent fallback).
 *  - `configured`:   at least one valid package -> normal aggregate view.
 */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseChecklist, type ChecklistParseResult } from "./checklist.ts";
import {
  canonicalTasksDir,
  findTrellisRoot,
  hash,
  isPathInside,
  loadSnapshot,
  readTaskJson,
  type BoardSnapshot,
  type SessionIdentity,
} from "./task-state.ts";

/** A localized, root/package/task-scoped data-quality note (not a blocker). */
export interface Diagnostic {
  code: string;
  message: string;
}

export interface RepositoryTaskSnapshot {
  /** canonical (realpath) task directory */
  taskPath: string;
  taskId: string;
  taskName: string;
  statusRaw: string;
  planning: boolean;
  checklist: ChecklistParseResult | null;
}

export interface RepositoryCounts {
  total: number;
  completed: number;
  inProgress: number;
  planning: number;
  review: number;
  unknown: number;
}

export interface RepositorySnapshot {
  packageName: string;
  /** path exactly as declared in config.yaml (relative to workspace root) */
  relativePath: string;
  /** canonical (realpath) package root */
  root: string;
  tasks: RepositoryTaskSnapshot[];
  counts: RepositoryCounts;
  warnings: Diagnostic[];
}

export interface WorkspaceTaskLink {
  workspaceTaskId: string;
  workspaceTaskName: string;
  workspaceStatus: string;
  ownerRepo: string;
  localTask: string;
  repository: RepositorySnapshot | null;
  repositoryTask: RepositoryTaskSnapshot | null;
  statusMatches: boolean;
  warning?: string;
}

export interface PackageConfig {
  name: string;
  rawPath: string;
  /** resolved absolute path (pre-realpath) */
  path: string;
  /** canonical realpath of the package root */
  realPath: string;
}

export type AggregateConfigState =
  | { kind: "unconfigured" }
  | { kind: "invalid"; diagnostics: Diagnostic[] }
  | { kind: "configured"; packages: PackageConfig[]; diagnostics: Diagnostic[] };

export interface AggregateBoardSnapshot {
  mode: "aggregate";
  /** canonical workspace Trellis root */
  root: string;
  configState: AggregateConfigState;
  workspace: BoardSnapshot;
  repositories: RepositorySnapshot[];
  links: WorkspaceTaskLink[];
  /** root-level diagnostics (config quality) */
  warnings: Diagnostic[];
  fingerprint: string;
}

/** Discriminated view: existing single-root snapshot or the new aggregate. */
export type BoardView = BoardSnapshot | AggregateBoardSnapshot;

export function isAggregate(view: BoardView): view is AggregateBoardSnapshot {
  return "mode" in view && view.mode === "aggregate";
}

export function viewMode(view: BoardView): "single" | "aggregate" {
  return isAggregate(view) ? "aggregate" : "single";
}

function emptyCounts(): RepositoryCounts {
  return { total: 0, completed: 0, inProgress: 0, planning: 0, review: 0, unknown: 0 };
}

function statSignature(p: string): string {
  if (!existsSync(p)) return "missing";
  try {
    const st = statSync(p);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : "not-file";
  } catch {
    return "unreadable";
  }
}

/**
 * Parse `.trellis/config.yaml` at a trusted root and classify the `packages`
 * declaration. Only `path` is used; `git`/`type`/other fields are ignored.
 */
export function parseConfigState(root: string): AggregateConfigState {
  const configPath = join(root, ".trellis", "config.yaml");
  if (!existsSync(configPath)) {
    return { kind: "unconfigured" };
  }
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return { kind: "invalid", diagnostics: [{ code: "config-unreadable", message: "config.yaml 不可读" }] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { kind: "invalid", diagnostics: [{ code: "config-yaml-parse", message: "config.yaml 无法解析" }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Scalar / empty document: no packages declared -> normal single-root mode.
    return { kind: "unconfigured" };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.packages === undefined || rec.packages === null) return { kind: "unconfigured" };
  if (typeof rec.packages !== "object" || Array.isArray(rec.packages)) {
    return {
      kind: "invalid",
      diagnostics: [{ code: "config-packages-type", message: "config.yaml 的 packages 结构无效" }],
    };
  }

  const entries = rec.packages as Record<string, unknown>;
  const names = Object.keys(entries);
  if (names.length === 0) return { kind: "unconfigured" };

  const packages: PackageConfig[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenReal: string[] = [];
  for (const name of names) {
    const entry = entries[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push({ code: "package-entry-invalid", message: `package ${name} 配置无效` });
      continue;
    }
    const e = entry as Record<string, unknown>;
    const rawPath = typeof e.path === "string" ? e.path.trim() : "";
    if (!rawPath) {
      diagnostics.push({ code: "package-path-missing", message: `package ${name} 缺少 path` });
      continue;
    }
    if (isAbsolute(rawPath)) {
      diagnostics.push({ code: "package-path-absolute", message: `package ${name} 使用绝对路径（拒绝）` });
      continue;
    }
    const resolved = resolve(root, rawPath);
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch {
      diagnostics.push({ code: "package-path-missing", message: `package ${name} 目录不存在（${rawPath}）` });
      continue;
    }
    if (!isPathInside(root, real)) {
      diagnostics.push({ code: "package-outside-root", message: `package ${name} 超出工作区根（${rawPath}）` });
      continue;
    }
    if (real === root) {
      diagnostics.push({ code: "package-self-reference", message: `package ${name} 指向工作区根自身（拒绝）` });
      continue;
    }
    if (seenReal.includes(real)) {
      diagnostics.push({ code: "package-duplicate", message: `package ${name} 与已配置 package 指向同一目录（去重）` });
      continue;
    }
    seenReal.push(real);
    packages.push({ name, rawPath, path: resolved, realPath: real });
  }

  if (packages.length === 0) {
    return { kind: "invalid", diagnostics };
  }
  return { kind: "configured", packages, diagnostics };
}

const REPO_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  planning: 2,
  unknown: 3,
  completed: 4,
};

/** Read one configured package's non-archived tasks. Never throws. */
export function readRepositorySnapshot(pkg: PackageConfig): RepositorySnapshot {
  const warnings: Diagnostic[] = [];
  const base = {
    packageName: pkg.name,
    relativePath: pkg.rawPath,
    root: pkg.realPath,
    tasks: [] as RepositoryTaskSnapshot[],
    counts: emptyCounts(),
    warnings,
  };

  const dotTrellis = join(pkg.realPath, ".trellis");
  let dotReal: string;
  try {
    dotReal = realpathSync(dotTrellis);
  } catch {
    warnings.push({ code: "repo-no-trellis", message: `${pkg.name}: 缺少 .trellis` });
    return base;
  }
  if (!isPathInside(pkg.realPath, dotReal)) {
    warnings.push({ code: "repo-trellis-escape", message: `${pkg.name}: .trellis 通过符号链接逃逸` });
    return base;
  }

  const tasksRoot = join(dotReal, "tasks");
  let tasksReal: string;
  try {
    tasksReal = realpathSync(tasksRoot);
  } catch {
    warnings.push({ code: "repo-no-tasks", message: `${pkg.name}: 缺少 .trellis/tasks` });
    return base;
  }
  if (!isPathInside(pkg.realPath, tasksReal)) {
    warnings.push({ code: "repo-tasks-escape", message: `${pkg.name}: .trellis/tasks 通过符号链接逃逸` });
    return base;
  }

  let entries: string[];
  try {
    if (!statSync(tasksReal).isDirectory()) {
      warnings.push({ code: "repo-no-tasks", message: `${pkg.name}: .trellis/tasks 不是目录` });
      return base;
    }
    entries = readdirSync(tasksReal);
  } catch {
    warnings.push({ code: "repo-tasks-unreadable", message: `${pkg.name}: 无法读取 .trellis/tasks` });
    return base;
  }

  const tasks: RepositoryTaskSnapshot[] = [];
  for (const name of entries) {
    if (name === "archive") continue;
    const dir = join(tasksReal, name);
    let realDir: string;
    try {
      if (!statSync(dir).isDirectory()) continue;
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    if (!isPathInside(tasksReal, realDir)) {
      warnings.push({ code: "task-outside-tasks", message: `${pkg.name}: 任务 ${name} 逃逸任务目录` });
      continue;
    }
    const taskData = readTaskJson(realDir);
    if (!taskData) {
      warnings.push({ code: "task-json-invalid", message: `${pkg.name}: 任务 ${name} 的 task.json 无效` });
      continue;
    }
    const statusRaw = typeof taskData.status === "string" ? taskData.status : "";
    const planning = statusRaw === "planning";
    const taskId = typeof taskData.id === "string" ? taskData.id : name;
    const taskName =
      (typeof taskData.title === "string" && taskData.title) ||
      (typeof taskData.name === "string" && taskData.name) ||
      taskId;
    let checklist: ChecklistParseResult | null = null;
    if (!planning) {
      const implPath = join(realDir, "implement.md");
      if (existsSync(implPath)) {
        try {
          if (statSync(implPath).isFile()) {
            checklist = parseChecklist(readFileSync(implPath, "utf8"));
          }
        } catch {
          checklist = null;
        }
      }
    }
    tasks.push({ taskPath: realDir, taskId, taskName, statusRaw, planning, checklist });
  }

  tasks.sort((a, b) => {
    const oa = REPO_STATUS_ORDER[a.statusRaw] ?? REPO_STATUS_ORDER.unknown;
    const ob = REPO_STATUS_ORDER[b.statusRaw] ?? REPO_STATUS_ORDER.unknown;
    if (oa !== ob) return oa - ob;
    // Same status: task directory name descending (newest date prefix first).
    return basename(b.taskPath).localeCompare(basename(a.taskPath));
  });

  const counts = emptyCounts();
  counts.total = tasks.length;
  for (const t of tasks) {
    if (t.statusRaw === "completed") counts.completed++;
    else if (t.statusRaw === "in_progress") counts.inProgress++;
    else if (t.statusRaw === "planning") counts.planning++;
    else if (t.statusRaw === "review") counts.review++;
    else counts.unknown++;
  }

  return { ...base, tasks, counts };
}

/** Stable ordering for the widget: in-progress repos first, config order kept. */
export function sortRepositories(repos: RepositorySnapshot[]): RepositorySnapshot[] {
  const index = new Map(repos.map((r, i) => [r, i]));
  return [...repos].sort((a, b) => {
    const ag = a.counts.inProgress > 0 ? 0 : 1;
    const bg = b.counts.inProgress > 0 ? 0 : 1;
    if (ag !== bg) return ag - bg;
    return (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

/** Narrow `task.json.meta` to an object. */
function readMeta(taskData: Record<string, unknown>): Record<string, unknown> {
  const meta = taskData.meta;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

/** A local-task ref is valid only as a single directory name (no path parts). */
function isSafeTaskName(raw: string): boolean {
  if (!raw || raw === "archive") return false;
  const parts = raw.split(/[\\/]+/);
  if (parts.length !== 1) return false;
  const seg = parts[0];
  return seg !== "" && seg !== "." && seg !== "..";
}

/**
 * Link workspace tasks (the current task itself plus its active direct
 * children) to repository tasks through `meta.owner-repo` + `meta.local-task`.
 * Archived or missing children never produce links. The link is advisory
 * only: it reports a status difference but never syncs or blocks.
 */
export function buildWorkspaceLinks(
  workspace: BoardSnapshot,
  root: string,
  repositories: RepositorySnapshot[],
): WorkspaceTaskLink[] {
  const candidates: Array<{ id: string; name: string; status: string; taskData: Record<string, unknown> }> = [];

  if (workspace.available && workspace.taskPath) {
    const data = readTaskJson(workspace.taskPath);
    if (data) {
      candidates.push({
        id: workspace.taskId ?? basename(workspace.taskPath),
        name: workspace.taskName ?? "",
        status: workspace.statusRaw ?? "",
        taskData: data,
      });
      const children = data.children;
      if (Array.isArray(children)) {
        const tasksDir = canonicalTasksDir(root);
        for (const c of children) {
          if (typeof c !== "string" || !c.trim()) continue;
          // Children must be safe direct task directory names: reject path
          // separators, `.`, `..` and `archive` before touching the filesystem,
          // so an explicit `archive/2026-08/task` child ref can never read or
          // link a root archived task, nor escape the tasks dir.
          if (!isSafeTaskName(c)) continue;
          const dir = join(root, ".trellis", "tasks", c);
          let real: string;
          try {
            real = realpathSync(dir);
          } catch {
            continue; // missing or archived child: not linked
          }
          if (!tasksDir || !isPathInside(tasksDir, real)) continue;
          const cd = readTaskJson(real);
          if (!cd) continue;
          const statusRaw = typeof cd.status === "string" ? cd.status : "";
          const name =
            (typeof cd.title === "string" && cd.title) ||
            (typeof cd.name === "string" && cd.name) ||
            basename(real);
          candidates.push({ id: basename(real), name, status: statusRaw, taskData: cd });
        }
      }
    }
  }

  const links: WorkspaceTaskLink[] = [];
  for (const cand of candidates) {
    const meta = readMeta(cand.taskData);
    const ownerRepo = typeof meta["owner-repo"] === "string" ? meta["owner-repo"].trim() : "";
    const localTask = typeof meta["local-task"] === "string" ? meta["local-task"].trim() : "";
    // Fully absent meta stays silent (no link). A partial mapping is a
    // data-quality problem and must surface a diagnostic, never disappear.
    if (!ownerRepo && !localTask) continue;

    // owner-repo must canonical-match a configured package (no unconfigured dirs).
    let resolvedOwner = "";
    try {
      resolvedOwner = realpathSync(resolve(root, ownerRepo));
    } catch {
      resolvedOwner = "";
    }
    const repository = resolvedOwner ? repositories.find((r) => r.root === resolvedOwner) : undefined;

    if (ownerRepo && !localTask) {
      // owner-repo present, local-task missing: resolve the repository when
      // possible and surface an explicit mapping-failure / unconfigured warning.
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository: repository ?? null,
        repositoryTask: null,
        statusMatches: false,
        warning: repository
          ? "缺少 local-task（无法定位仓库内任务）"
          : "owner-repo 未匹配任何已配置 package",
      });
      continue;
    }
    if (!ownerRepo && localTask) {
      // local-task present without owner-repo: cannot locate a repository.
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository: null,
        repositoryTask: null,
        statusMatches: false,
        warning: "缺少 owner-repo（无法定位仓库）",
      });
      continue;
    }

    if (!repository) {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository: null,
        repositoryTask: null,
        statusMatches: false,
        warning: "owner-repo 未匹配任何已配置 package",
      });
      continue;
    }
    if (!isSafeTaskName(localTask)) {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository,
        repositoryTask: null,
        statusMatches: false,
        warning: "local-task 引用无效（拒绝路径/archive）",
      });
      continue;
    }

    const tasksRoot = join(repository.root, ".trellis", "tasks");
    let tasksReal: string;
    try {
      tasksReal = realpathSync(tasksRoot);
    } catch {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository,
        repositoryTask: null,
        statusMatches: false,
        warning: "无法解析仓库任务目录",
      });
      continue;
    }
    if (!isPathInside(repository.root, tasksReal)) {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository,
        repositoryTask: null,
        statusMatches: false,
        warning: "仓库任务目录超出安全范围",
      });
      continue;
    }

    const taskDir = join(tasksReal, localTask);
    let realTask: string;
    try {
      realTask = realpathSync(taskDir);
    } catch {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository,
        repositoryTask: null,
        statusMatches: false,
        warning: "local-task 任务不存在",
      });
      continue;
    }
    if (!isPathInside(tasksReal, realTask)) {
      links.push({
        workspaceTaskId: cand.id,
        workspaceTaskName: cand.name,
        workspaceStatus: cand.status,
        ownerRepo,
        localTask,
        repository,
        repositoryTask: null,
        statusMatches: false,
        warning: "local-task 超出任务目录",
      });
      continue;
    }

    const repositoryTask = repository.tasks.find((t) => t.taskPath === realTask) ?? null;
    links.push({
      workspaceTaskId: cand.id,
      workspaceTaskName: cand.name,
      workspaceStatus: cand.status,
      ownerRepo,
      localTask,
      repository,
      repositoryTask,
      statusMatches: repositoryTask ? repositoryTask.statusRaw === cand.status : false,
    });
  }
  return links;
}

function computeAggregateFingerprint(
  root: string,
  config: AggregateConfigState,
  workspace: BoardSnapshot,
  repositories: RepositorySnapshot[],
  links: WorkspaceTaskLink[],
  warnings: Diagnostic[],
): string {
  const parts: string[] = [];
  parts.push(`config:${statSignature(join(root, ".trellis", "config.yaml"))}`);
  parts.push(`workspace:${workspace.fingerprint ?? ""}`);
  for (const repo of repositories) {
    // Counts and warnings must be part of the fingerprint: a repository can
    // gain or lose availability/diagnostics (e.g. repo-no-trellis) even when
    // it has no tasks at all, and those transitions must trigger a refresh.
    parts.push(`repo:${repo.root}:${JSON.stringify(repo.counts)}:${JSON.stringify(repo.warnings)}`);
    for (const t of repo.tasks) {
      parts.push(
        `task:${t.taskPath}:${statSignature(join(t.taskPath, "task.json"))}:${statSignature(join(t.taskPath, "implement.md"))}`,
      );
    }
  }
  parts.push(
    `links:${JSON.stringify(links.map((l) => [l.workspaceTaskId, l.workspaceTaskName, l.workspaceStatus, l.ownerRepo, l.localTask, l.statusMatches, l.warning ?? ""]))}`,
  );
  parts.push(`warnings:${JSON.stringify(warnings)}`);
  return hash(parts.join("|"));
}

/** Build an aggregate snapshot from an already-parsed config state. */
export function buildAggregate(
  root: string,
  workspace: BoardSnapshot,
  config: AggregateConfigState,
): AggregateBoardSnapshot {
  const warnings: Diagnostic[] = config.kind === "unconfigured" ? [] : [...config.diagnostics];
  const repositories: RepositorySnapshot[] =
    config.kind === "configured" ? config.packages.map(readRepositorySnapshot) : [];
  const links = buildWorkspaceLinks(workspace, root, repositories);
  const fingerprint = computeAggregateFingerprint(root, config, workspace, repositories, links, warnings);
  return { mode: "aggregate", root, configState: config, workspace, repositories, links, warnings, fingerprint };
}

/**
 * Load the board view for a session. Untrusted and non-Trellis projects
 * deactivate quietly (same as `loadSnapshot`). With no declared packages the
 * plain single-root snapshot is returned unchanged; with an explicit (valid
 * or invalid) packages declaration an aggregate view is returned.
 */
export function loadBoard(cwd: string, identity: SessionIdentity, trusted: boolean): BoardView {
  if (!trusted) {
    return { available: false, degraded: false, reason: "untrusted" };
  }
  const root = findTrellisRoot(cwd);
  if (!root) {
    return { available: false, degraded: false, reason: "not-trellis" };
  }
  const workspace = loadSnapshot(cwd, identity, trusted);
  const config = parseConfigState(root);
  if (config.kind === "unconfigured") {
    return workspace;
  }
  return buildAggregate(root, workspace, config);
}
