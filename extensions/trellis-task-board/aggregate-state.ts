/**
 * Read-only parent/child Trellis workspace discovery and aggregate state.
 *
 * Repository roots come from explicit packages, safe root-task owner metadata,
 * and a bounded scan inside the canonical outer workspace. Every source is
 * canonicalized, containment-checked and deduplicated. Mutation remains in
 * mutation.ts and receives no repository/path parameter.
 */

import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseChecklist, type ChecklistParseResult } from "./checklist.ts";
import {
  canonicalTasksDir,
  findTrellisRoots,
  hash,
  isPathInside,
  loadSnapshotAtRoot,
  readTaskJson,
  type BoardSnapshot,
  type SessionIdentity,
} from "./task-state.ts";

export interface Diagnostic {
  code: string;
  message: string;
}

export interface RepositoryTaskSnapshot {
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

export type RepositorySource = "package" | "owner-repo" | "discovered";

export interface RepositorySnapshot {
  packageName: string;
  relativePath: string;
  root: string;
  source?: RepositorySource;
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
  path: string;
  realPath: string;
  source?: RepositorySource;
}

export type AggregateConfigState =
  | { kind: "unconfigured" }
  | { kind: "invalid"; diagnostics: Diagnostic[] }
  | { kind: "configured"; packages: PackageConfig[]; diagnostics: Diagnostic[] };

export type ActiveBinding =
  | { kind: "unbound" }
  | { kind: "bound"; root: string; repository: RepositorySnapshot | null; snapshot: BoardSnapshot }
  | { kind: "ambiguous"; bindings: Array<{ root: string; taskId: string | null; taskName: string | null }> };

export interface AggregateBoardSnapshot {
  mode: "aggregate";
  /** canonical outer workspace root */
  root: string;
  workspaceRoot?: string;
  /** nearest ancestor Trellis root containing cwd */
  cwdRoot?: string;
  configState: AggregateConfigState;
  /** session snapshot at the outer workspace root (compatibility field) */
  workspace: BoardSnapshot;
  /** all direct non-archive tasks at the outer root, independent of sessions */
  workspaceRepository?: RepositorySnapshot;
  repositories: RepositorySnapshot[];
  links: WorkspaceTaskLink[];
  activeBinding?: ActiveBinding;
  warnings: Diagnostic[];
  fingerprint: string;
}

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

function statSignature(path: string, containmentRoot?: string): string {
  try {
    const realPath = realpathSync(path);
    if (containmentRoot && !isPathInside(containmentRoot, realPath)) return "unsafe";
    const stat = statSync(realPath);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : `dir:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function readContainedText(path: string, containmentRoot: string): string | null {
  try {
    const realPath = realpathSync(path);
    if (!isPathInside(containmentRoot, realPath) || !statSync(realPath).isFile()) return null;
    return readFileSync(realPath, "utf8");
  } catch {
    return null;
  }
}

/** Parse and validate root `.trellis/config.yaml` packages. */
export function parseConfigState(root: string): AggregateConfigState {
  const configPath = join(root, ".trellis", "config.yaml");
  if (!existsSync(configPath)) return { kind: "unconfigured" };
  const configText = readContainedText(configPath, root);
  if (configText === null) {
    return { kind: "invalid", diagnostics: [{ code: "config-path-unsafe", message: "config.yaml 超出安全范围或无法读取" }] };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(configText);
  } catch {
    return { kind: "invalid", diagnostics: [{ code: "config-yaml-parse", message: "config.yaml 无法解析" }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unconfigured" };
  const packagesValue = (parsed as Record<string, unknown>).packages;
  if (packagesValue === undefined || packagesValue === null) return { kind: "unconfigured" };
  if (typeof packagesValue !== "object" || Array.isArray(packagesValue)) {
    return { kind: "invalid", diagnostics: [{ code: "config-packages-type", message: "config.yaml 的 packages 结构无效" }] };
  }

  const entries = packagesValue as Record<string, unknown>;
  if (Object.keys(entries).length === 0) return { kind: "unconfigured" };
  const packages: PackageConfig[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      diagnostics.push({ code: "package-entry-invalid", message: `package ${name} 配置无效` });
      continue;
    }
    const rawPath = typeof (value as Record<string, unknown>).path === "string"
      ? ((value as Record<string, unknown>).path as string).trim()
      : "";
    if (!rawPath) {
      diagnostics.push({ code: "package-path-missing", message: `package ${name} 缺少 path` });
      continue;
    }
    if (isAbsolute(rawPath)) {
      diagnostics.push({ code: "package-path-absolute", message: `package ${name} 使用绝对路径（拒绝）` });
      continue;
    }
    const path = resolve(root, rawPath);
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      diagnostics.push({ code: "package-path-missing", message: `package ${name} 目录不存在（${rawPath}）` });
      continue;
    }
    if (!isPathInside(root, realPath)) {
      diagnostics.push({ code: "package-outside-root", message: `package ${name} 超出工作区根（${rawPath}）` });
      continue;
    }
    if (realPath === root) {
      diagnostics.push({ code: "package-self-reference", message: `package ${name} 指向工作区根自身（拒绝）` });
      continue;
    }
    if (seen.has(realPath)) {
      diagnostics.push({ code: "package-duplicate", message: `package ${name} 与已配置 package 指向同一目录（去重）` });
      continue;
    }
    seen.add(realPath);
    packages.push({ name, rawPath, path, realPath, source: "package" });
  }
  return packages.length > 0
    ? { kind: "configured", packages, diagnostics }
    : { kind: "invalid", diagnostics };
}

const SKIPPED_DIRECTORIES = new Set([
  ".git", ".trellis", ".hg", ".svn", ".idea", ".vscode",
  "node_modules", "dist", "build", "target", "coverage", ".cache",
  ".next", ".nuxt", ".turbo", ".gradle", "out", "vendor",
]);
export const DISCOVERY_MAX_DIRECTORIES = 2000;
export const DISCOVERY_MAX_DEPTH = 8;

export interface DiscoveryResult {
  packages: PackageConfig[];
  diagnostics: Diagnostic[];
  visited: number;
}

/** Bounded, non-recursive-by-symlink discovery of nested Trellis roots. */
export function discoverNestedTrellisRoots(
  workspaceRoot: string,
  options: { maxDirectories?: number; maxDepth?: number } = {},
): DiscoveryResult {
  const maxDirectories = options.maxDirectories ?? DISCOVERY_MAX_DIRECTORIES;
  const maxDepth = options.maxDepth ?? DISCOVERY_MAX_DEPTH;
  const diagnostics: Diagnostic[] = [];
  const packages: PackageConfig[] = [];
  let canonicalWorkspaceRoot: string;
  try {
    canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  } catch {
    return { packages, diagnostics: [{ code: "discovery-root-unreadable", message: "无法解析工作区根" }], visited: 0 };
  }
  const queue: Array<{ path: string; depth: number }> = [{ path: canonicalWorkspaceRoot, depth: 0 }];
  const seenDirectories = new Set<string>([canonicalWorkspaceRoot]);
  let visited = 0;

  while (queue.length > 0) {
    if (visited >= maxDirectories) {
      diagnostics.push({ code: "discovery-budget", message: `自动发现达到目录预算（${maxDirectories}），结果可能不完整` });
      break;
    }
    const current = queue.shift()!;
    visited++;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      diagnostics.push({ code: "discovery-unreadable", message: `无法读取目录：${relative(canonicalWorkspaceRoot, current.path) || "."}` });
      continue;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      const candidate = join(current.path, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = realpathSync(candidate);
          if (!isPathInside(canonicalWorkspaceRoot, target)) {
            diagnostics.push({ code: "discovery-symlink-escape", message: `符号链接超出工作区（拒绝）：${relative(canonicalWorkspaceRoot, candidate)}` });
          }
        } catch {
          diagnostics.push({ code: "discovery-symlink-unreadable", message: `无法解析符号链接：${relative(canonicalWorkspaceRoot, candidate)}` });
        }
        continue; // discovery never traverses directory symlinks
      }
      if (!entry.isDirectory() || current.depth >= maxDepth) continue;
      let realCandidate: string;
      try {
        realCandidate = realpathSync(candidate);
      } catch {
        diagnostics.push({ code: "discovery-entry-unreadable", message: `无法解析目录：${relative(canonicalWorkspaceRoot, candidate)}` });
        continue;
      }
      if (!isPathInside(canonicalWorkspaceRoot, realCandidate)) {
        diagnostics.push({ code: "discovery-outside-root", message: `自动发现目录超出工作区（拒绝）：${relative(canonicalWorkspaceRoot, candidate)}` });
        continue;
      }
      if (seenDirectories.has(realCandidate)) continue;
      seenDirectories.add(realCandidate);
      if (canonicalTasksDir(realCandidate)) {
        const rawPath = relative(canonicalWorkspaceRoot, realCandidate).split(sep).join("/");
        packages.push({ name: rawPath, rawPath, path: candidate, realPath: realCandidate, source: "discovered" });
      }
      queue.push({ path: realCandidate, depth: current.depth + 1 });
    }
  }
  return { packages, diagnostics, visited };
}

function readMeta(taskData: Record<string, unknown>): Record<string, unknown> {
  const meta = taskData.meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
}

/** Collect safe owner-repo directories from all direct root task metadata. */
export function discoverOwnerRepositories(root: string): DiscoveryResult {
  const packages: PackageConfig[] = [];
  const diagnostics: Diagnostic[] = [];
  const tasksDir = canonicalTasksDir(root);
  if (!tasksDir) return { packages, diagnostics, visited: 0 };
  let taskNames: string[];
  try {
    taskNames = readdirSync(tasksDir);
  } catch {
    return { packages, diagnostics: [{ code: "owner-tasks-unreadable", message: "无法读取根任务元数据" }], visited: 0 };
  }
  const seen = new Set<string>();
  for (const taskName of taskNames) {
    if (taskName === "archive") continue;
    const candidate = join(tasksDir, taskName);
    let taskPath: string;
    try {
      taskPath = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!statSync(taskPath).isDirectory()) continue;
    if (!isPathInside(tasksDir, taskPath)) {
      diagnostics.push({ code: "owner-task-escape", message: `任务 ${taskName} 逃逸任务目录（拒绝）` });
      continue;
    }
    const taskData = readTaskJson(taskPath);
    if (!taskData) continue;
    const owner = typeof readMeta(taskData)["owner-repo"] === "string"
      ? (readMeta(taskData)["owner-repo"] as string).trim()
      : "";
    if (!owner) continue;
    if (isAbsolute(owner)) {
      diagnostics.push({ code: "owner-repo-absolute", message: `任务 ${taskName} 的 owner-repo 为绝对路径（拒绝）` });
      continue;
    }
    let realPath: string;
    try {
      realPath = realpathSync(resolve(root, owner));
    } catch {
      diagnostics.push({ code: "owner-repo-missing", message: `任务 ${taskName} 的 owner-repo 不存在（${owner}）` });
      continue;
    }
    if (realPath === root || !isPathInside(root, realPath) || !canonicalTasksDir(realPath)) {
      diagnostics.push({ code: "owner-repo-unsafe", message: `任务 ${taskName} 的 owner-repo 无效或超出工作区（${owner}）` });
      continue;
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);
    const rawPath = relative(root, realPath).split(sep).join("/");
    packages.push({ name: rawPath, rawPath, path: resolve(root, owner), realPath, source: "owner-repo" });
  }
  return { packages, diagnostics, visited: taskNames.length };
}

/** Merge source priority: explicit package, owner metadata, bounded scan. */
export function mergeRepositorySources(
  configured: PackageConfig[],
  owner: PackageConfig[],
  discovered: PackageConfig[],
): { packages: PackageConfig[]; diagnostics: Diagnostic[] } {
  const packages: PackageConfig[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const pkg of [...configured, ...owner, ...discovered]) {
    if (seen.has(pkg.realPath)) {
      if (pkg.source === "package") diagnostics.push({ code: "repository-duplicate", message: `重复仓库已去重：${pkg.rawPath}` });
      continue;
    }
    seen.add(pkg.realPath);
    packages.push(pkg);
  }
  return { packages, diagnostics };
}

const REPO_STATUS_ORDER: Record<string, number> = { in_progress: 0, review: 1, planning: 2, unknown: 3, completed: 4 };

/** Read one repository's direct, non-archive tasks. Never throws. */
export function readRepositorySnapshot(pkg: PackageConfig): RepositorySnapshot {
  const warnings: Diagnostic[] = [];
  const base = {
    packageName: pkg.name,
    relativePath: pkg.rawPath,
    root: pkg.realPath,
    source: pkg.source,
    tasks: [] as RepositoryTaskSnapshot[],
    counts: emptyCounts(),
    warnings,
  };
  let dot: string;
  try {
    dot = realpathSync(join(pkg.realPath, ".trellis"));
  } catch {
    warnings.push({ code: "repo-no-trellis", message: `${pkg.name}: 缺少 .trellis` });
    return base;
  }
  if (!isPathInside(pkg.realPath, dot)) {
    warnings.push({ code: "repo-trellis-escape", message: `${pkg.name}: .trellis 通过符号链接逃逸` });
    return base;
  }
  let tasksRoot: string;
  try {
    tasksRoot = realpathSync(join(dot, "tasks"));
  } catch {
    warnings.push({ code: "repo-no-tasks", message: `${pkg.name}: 缺少 .trellis/tasks` });
    return base;
  }
  if (!isPathInside(dot, tasksRoot)) {
    warnings.push({ code: "repo-tasks-escape", message: `${pkg.name}: .trellis/tasks 通过符号链接逃逸` });
    return base;
  }
  let entries: string[];
  try {
    if (!statSync(tasksRoot).isDirectory()) throw new Error("not-dir");
    entries = readdirSync(tasksRoot);
  } catch {
    warnings.push({ code: "repo-tasks-unreadable", message: `${pkg.name}: 无法读取 .trellis/tasks` });
    return base;
  }

  const tasks: RepositoryTaskSnapshot[] = [];
  for (const name of entries) {
    if (name === "archive") continue;
    const candidate = join(tasksRoot, name);
    let taskPath: string;
    try {
      if (!statSync(candidate).isDirectory()) continue;
      taskPath = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isPathInside(tasksRoot, taskPath)) {
      warnings.push({ code: "task-outside-tasks", message: `${pkg.name}: 任务 ${name} 逃逸任务目录` });
      continue;
    }
    const data = readTaskJson(taskPath);
    if (!data) {
      warnings.push({ code: "task-json-invalid", message: `${pkg.name}: 任务 ${name} 的 task.json 无效` });
      continue;
    }
    const statusRaw = typeof data.status === "string" ? data.status : "";
    const planning = statusRaw === "planning";
    const taskId = typeof data.id === "string" ? data.id : name;
    const taskName =
      (typeof data.title === "string" && data.title) ||
      (typeof data.name === "string" && data.name) || taskId;
    let checklist: ChecklistParseResult | null = null;
    if (!planning) {
      const implementText = readContainedText(join(taskPath, "implement.md"), taskPath);
      if (implementText !== null) checklist = parseChecklist(implementText);
    }
    tasks.push({ taskPath, taskId, taskName, statusRaw, planning, checklist });
  }
  tasks.sort((a, b) => {
    const status = (REPO_STATUS_ORDER[a.statusRaw] ?? REPO_STATUS_ORDER.unknown) -
      (REPO_STATUS_ORDER[b.statusRaw] ?? REPO_STATUS_ORDER.unknown);
    return status || basename(b.taskPath).localeCompare(basename(a.taskPath));
  });
  const counts = emptyCounts();
  counts.total = tasks.length;
  for (const task of tasks) {
    if (task.statusRaw === "completed") counts.completed++;
    else if (task.statusRaw === "in_progress") counts.inProgress++;
    else if (task.statusRaw === "planning") counts.planning++;
    else if (task.statusRaw === "review") counts.review++;
    else counts.unknown++;
  }
  return { ...base, tasks, counts };
}

export function sortRepositories(repositories: RepositorySnapshot[]): RepositorySnapshot[] {
  const original = new Map(repositories.map((repository, index) => [repository, index]));
  return [...repositories].sort((a, b) => {
    const active = Number(b.counts.inProgress > 0) - Number(a.counts.inProgress > 0);
    return active || (original.get(a) ?? 0) - (original.get(b) ?? 0);
  });
}

function isSafeTaskName(raw: string): boolean {
  return Boolean(raw && raw !== "archive" && raw !== "." && raw !== ".." && !/[\\/]/.test(raw));
}

export function buildWorkspaceLinks(
  workspace: BoardSnapshot,
  root: string,
  repositories: RepositorySnapshot[],
): WorkspaceTaskLink[] {
  const candidates: Array<{ id: string; name: string; status: string; data: Record<string, unknown> }> = [];
  if (workspace.available && workspace.taskPath) {
    const data = readTaskJson(workspace.taskPath);
    if (data) {
      candidates.push({ id: workspace.taskId ?? basename(workspace.taskPath), name: workspace.taskName ?? "", status: workspace.statusRaw ?? "", data });
      const children = data.children;
      if (Array.isArray(children)) {
        const tasksDir = canonicalTasksDir(root);
        for (const child of children) {
          if (typeof child !== "string" || !isSafeTaskName(child)) continue;
          let taskPath: string;
          try {
            taskPath = realpathSync(join(root, ".trellis", "tasks", child));
          } catch {
            continue;
          }
          if (!tasksDir || !isPathInside(tasksDir, taskPath)) continue;
          const childData = readTaskJson(taskPath);
          if (!childData) continue;
          const status = typeof childData.status === "string" ? childData.status : "";
          const name = (typeof childData.title === "string" && childData.title) || (typeof childData.name === "string" && childData.name) || basename(taskPath);
          candidates.push({ id: basename(taskPath), name, status, data: childData });
        }
      }
    }
  }

  const links: WorkspaceTaskLink[] = [];
  for (const candidate of candidates) {
    const meta = readMeta(candidate.data);
    const ownerRepo = typeof meta["owner-repo"] === "string" ? (meta["owner-repo"] as string).trim() : "";
    const localTask = typeof meta["local-task"] === "string" ? (meta["local-task"] as string).trim() : "";
    if (!ownerRepo && !localTask) continue;
    let ownerPath = "";
    try {
      ownerPath = realpathSync(resolve(root, ownerRepo));
    } catch {
      // handled as an unmatched mapping below
    }
    const repository = repositories.find((repo) => repo.root === ownerPath) ?? null;
    const base = {
      workspaceTaskId: candidate.id,
      workspaceTaskName: candidate.name,
      workspaceStatus: candidate.status,
      ownerRepo,
      localTask,
      repository,
      repositoryTask: null,
      statusMatches: false,
    };
    if (!ownerRepo) {
      links.push({ ...base, warning: "缺少 owner-repo（无法定位仓库）" });
      continue;
    }
    if (!repository) {
      links.push({ ...base, warning: "owner-repo 未匹配任何已发现仓库" });
      continue;
    }
    if (!localTask) {
      links.push({ ...base, warning: "缺少 local-task（无法定位仓库内任务）" });
      continue;
    }
    if (!isSafeTaskName(localTask)) {
      links.push({ ...base, warning: "local-task 引用无效（拒绝路径/archive）" });
      continue;
    }
    const repositoryTask = repository.tasks.find((task) => basename(task.taskPath) === localTask) ?? null;
    if (!repositoryTask) {
      links.push({ ...base, warning: "local-task 任务不存在" });
      continue;
    }
    links.push({ ...base, repositoryTask, statusMatches: repositoryTask.statusRaw === candidate.status });
  }
  return links;
}

function computeAggregateFingerprint(view: Omit<AggregateBoardSnapshot, "fingerprint">, snapshots: BoardSnapshot[]): string {
  const parts = [
    `root:${view.root}`,
    `cwd:${view.cwdRoot ?? ""}`,
    `config:${statSignature(join(view.root, ".trellis", "config.yaml"), view.root)}`,
    `binding:${JSON.stringify(view.activeBinding)}`,
    `warnings:${JSON.stringify(view.warnings)}`,
    ...snapshots.map((snapshot) => `session:${snapshot.root}:${snapshot.fingerprint ?? ""}`),
  ];
  if (view.workspaceRepository) {
    parts.push(`workspace-repo:${JSON.stringify(view.workspaceRepository.counts)}:${JSON.stringify(view.workspaceRepository.warnings)}`);
    for (const task of view.workspaceRepository.tasks) {
      parts.push(`workspace-task:${task.taskPath}:${statSignature(join(task.taskPath, "task.json"), task.taskPath)}:${statSignature(join(task.taskPath, "implement.md"), task.taskPath)}`);
    }
  }
  for (const repository of view.repositories) {
    parts.push(`repo:${repository.root}:${repository.source}:${JSON.stringify(repository.counts)}:${JSON.stringify(repository.warnings)}`);
    for (const task of repository.tasks) {
      parts.push(`task:${task.taskPath}:${statSignature(join(task.taskPath, "task.json"), task.taskPath)}:${statSignature(join(task.taskPath, "implement.md"), task.taskPath)}`);
    }
  }
  parts.push(`links:${JSON.stringify(view.links.map((link) => [link.workspaceTaskId, link.workspaceStatus, link.ownerRepo, link.localTask, link.statusMatches, link.warning]))}`);
  return hash(parts.join("|"));
}

function resolveActiveBinding(
  workspaceRoot: string,
  repositories: RepositorySnapshot[],
  snapshots: BoardSnapshot[],
): ActiveBinding {
  const available = snapshots.filter((snapshot) => snapshot.available && snapshot.root && snapshot.taskPath);
  if (available.length === 0) return { kind: "unbound" };
  if (available.length > 1) {
    return {
      kind: "ambiguous",
      bindings: available.map((snapshot) => ({ root: snapshot.root!, taskId: snapshot.taskId ?? null, taskName: snapshot.taskName ?? null })),
    };
  }
  const snapshot = available[0];
  return {
    kind: "bound",
    root: snapshot.root!,
    repository: snapshot.root === workspaceRoot ? null : repositories.find((repo) => repo.root === snapshot.root) ?? null,
    snapshot,
  };
}

/** Compatibility builder used by existing tests and callers with explicit config. */
export function buildAggregate(root: string, workspace: BoardSnapshot, config: AggregateConfigState): AggregateBoardSnapshot {
  const configured = config.kind === "configured" ? config.packages : [];
  const workspaceRepository = readRepositorySnapshot({
    name: "工作区根", rawPath: ".", path: root, realPath: root, source: "discovered",
  });
  const repositories = configured.map(readRepositorySnapshot);
  const warnings = config.kind === "unconfigured" ? [] : [...config.diagnostics];
  const activeBinding: ActiveBinding = workspace.available
    ? { kind: "bound", root, repository: null, snapshot: workspace }
    : { kind: "unbound" };
  const links = buildWorkspaceLinks(workspace, root, repositories);
  const partial: Omit<AggregateBoardSnapshot, "fingerprint"> = {
    mode: "aggregate", root, workspaceRoot: root, cwdRoot: root, configState: config,
    workspace, workspaceRepository, repositories, links, activeBinding, warnings,
  };
  return { ...partial, fingerprint: computeAggregateFingerprint(partial, [workspace]) };
}

/**
 * Load a trusted workspace board. The outermost Trellis ancestor is the
 * workspace boundary; the nearest ancestor identifies cwd's repository.
 */
export function loadBoard(cwd: string, identity: SessionIdentity, trusted: boolean): BoardView {
  if (!trusted) return { available: false, degraded: false, reason: "untrusted" };
  const ancestorRoots = findTrellisRoots(cwd);
  if (ancestorRoots.length === 0) return { available: false, degraded: false, reason: "not-trellis" };
  const cwdRoot = ancestorRoots[0];
  const workspaceRoot = ancestorRoots[ancestorRoots.length - 1];
  const configState = parseConfigState(workspaceRoot);
  const configured = configState.kind === "configured" ? configState.packages : [];
  const owner = discoverOwnerRepositories(workspaceRoot);
  const discovery = discoverNestedTrellisRoots(workspaceRoot);
  // Ancestor child roots are guaranteed candidates even when a shallow scan
  // budget is exhausted before reaching cwd.
  const ancestorPackages: PackageConfig[] = ancestorRoots.slice(0, -1).map((root) => {
    const rawPath = relative(workspaceRoot, root).split(sep).join("/");
    return { name: rawPath, rawPath, path: root, realPath: root, source: "discovered" };
  });
  const merged = mergeRepositorySources(configured, owner.packages, [...ancestorPackages, ...discovery.packages]);

  const shouldAggregate = merged.packages.length > 0 || configState.kind === "invalid" || ancestorRoots.length > 1;
  if (!shouldAggregate) return loadSnapshotAtRoot(cwdRoot, identity, trusted);

  // In a multi-root workspace, sole-file fallback would make unrelated old
  // sessions look like the current Pi session. Resolve explicit identity keys
  // only; session-scoped binding must not be inferred from another session.
  const workspace = loadSnapshotAtRoot(workspaceRoot, identity, trusted, { allowSoleSessionFallback: false });
  const workspaceRepository = readRepositorySnapshot({
    name: "工作区根", rawPath: ".", path: workspaceRoot, realPath: workspaceRoot, source: "discovered",
  });
  const repositories = merged.packages.map(readRepositorySnapshot);
  const rootSnapshots = [
    workspace,
    ...repositories.map((repository) => loadSnapshotAtRoot(repository.root, identity, trusted, { allowSoleSessionFallback: false })),
  ];
  const activeBinding = resolveActiveBinding(workspaceRoot, repositories, rootSnapshots);
  const warnings: Diagnostic[] = [
    ...(configState.kind === "unconfigured" ? [] : configState.diagnostics),
    ...owner.diagnostics,
    ...discovery.diagnostics,
    ...merged.diagnostics,
  ];
  if (activeBinding.kind === "ambiguous") {
    warnings.push({ code: "active-binding-ambiguous", message: `当前 Pi 会话在 ${activeBinding.bindings.length} 个 Trellis 根中绑定任务；拒绝猜测` });
  }
  const links = buildWorkspaceLinks(workspace, workspaceRoot, repositories);
  const partial: Omit<AggregateBoardSnapshot, "fingerprint"> = {
    mode: "aggregate",
    root: workspaceRoot,
    workspaceRoot,
    cwdRoot,
    configState,
    workspace,
    workspaceRepository,
    repositories,
    links,
    activeBinding,
    warnings,
  };
  return { ...partial, fingerprint: computeAggregateFingerprint(partial, rootSnapshots) };
}

/** Resolve the only safe writable snapshot for the current workspace session. */
export function loadWritableSnapshot(cwd: string, identity: SessionIdentity, trusted: boolean): BoardSnapshot {
  const view = loadBoard(cwd, identity, trusted);
  if (!isAggregate(view)) return view;
  if (view.activeBinding?.kind === "bound") return view.activeBinding.snapshot;
  return {
    available: false,
    degraded: view.activeBinding?.kind === "ambiguous",
    reason: view.activeBinding?.kind === "ambiguous" ? "ambiguous-active-binding" : "no-session",
    root: view.root,
    fingerprint: view.fingerprint,
  };
}
