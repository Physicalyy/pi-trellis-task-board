/**
 * Trusted Trellis project discovery, session-key compatibility, current-task
 * resolution and canonical path containment.
 *
 * Everything here is read-only. The single write boundary lives in mutation.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseChecklist, type ChecklistParseResult } from "./checklist.ts";

export interface SessionIdentity {
  sessionId?: string | null;
  transcriptPath?: string | null;
}

export interface BoardSnapshot {
  /** A trusted Trellis root with a uniquely resolvable current task. */
  available: boolean;
  /** Board data missing, malformed, ambiguous or unsafe. Not a task blocker. */
  degraded: boolean;
  reason?: string;
  root?: string;
  contextKey?: string | null;
  sourceType?: "session" | "session-fallback" | "none";
  /** canonical (realpath) task directory */
  taskPath?: string;
  taskId?: string | null;
  taskName?: string | null;
  statusRaw?: string;
  planning?: boolean;
  checklist?: ChecklistParseResult | null;
  fingerprint?: string;
}

/** sha256 hex digest truncated to 24 hex chars, matching Trellis `_hash_value`. */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Mirrors `active_task.py::_sanitize_key`. */
export function sanitizeKey(raw: string): string {
  let safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  safe = safe.replace(/^[.\-_]+|[.\-_]+$/g, "");
  return safe.slice(0, 160);
}

/** Ordered, deduplicated session-key candidates for the current Pi session. */
export function resolveContextKeys(id: SessionIdentity): string[] {
  const keys: string[] = [];
  const sessionId = id.sessionId ? id.sessionId.trim() : "";
  if (sessionId) {
    const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (!normalized) keys.push(`pi_${hash(sessionId)}`);
    else keys.push(`pi_${normalized}${normalized === sessionId ? "" : `_${hash(sessionId)}`}`);
    const safe = sanitizeKey(sessionId);
    keys.push(safe ? `pi_${safe}` : `pi_${hash(sessionId)}`);
  }
  const transcriptPath = id.transcriptPath ? id.transcriptPath.trim() : "";
  if (transcriptPath) keys.push(`pi_transcript_${hash(transcriptPath)}`);
  return [...new Set(keys)];
}

function hasTrellisDirectory(candidate: string): boolean {
  const dot = join(candidate, ".trellis");
  try {
    return existsSync(dot) && statSync(dot).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Collect every Trellis root on cwd's ancestor chain, nearest first. Roots are
 * canonicalized and deduplicated; unrelated siblings are never considered.
 */
export function findTrellisRoots(cwd: string): string[] {
  let cur = resolve(cwd);
  try {
    // Canonicalize cwd before walking parents so a cwd reached through a
    // directory symlink cannot inherit the symlink's unrelated lexical parent.
    cur = realpathSync(cur);
  } catch {
    // A missing cwd simply produces no Trellis root below.
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (let guard = 0; guard <= 1000; guard++) {
    if (hasTrellisDirectory(cur)) {
      let canonical = cur;
      try {
        canonical = realpathSync(cur);
      } catch {
        // Keep the resolved ancestor only as a degraded-state anchor. Later
        // canonical boundary checks still fail closed.
      }
      if (!seen.has(canonical)) {
        seen.add(canonical);
        roots.push(canonical);
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

/** Walk upward from cwd to the nearest ancestor containing `.trellis/`. */
export function findTrellisRoot(cwd: string): string | null {
  return findTrellisRoots(cwd)[0] ?? null;
}

/** Canonical containment check using path-relative semantics, not string prefixes. */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Normalize a task ref for resolution, mirroring `normalize_task_ref`. */
export function normalizeTaskRef(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  if (isAbsolute(s)) return s;
  s = s.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("tasks/")) return `.trellis/${s}`;
  return s;
}

/** Resolve a normalized task ref to a candidate task directory under the repo. */
export function resolveTaskDir(root: string, ref: string): string | null {
  const normalized = normalizeTaskRef(ref);
  if (!normalized) return null;
  if (isAbsolute(normalized)) return normalized;
  if (normalized.startsWith(".trellis/")) return join(root, normalized);
  return join(root, ".trellis", "tasks", normalized);
}

/** Canonical, contained `.trellis/tasks` dir for a Trellis root, or null. */
export function canonicalTasksDir(root: string): string | null {
  try {
    const canonicalRoot = realpathSync(root);
    const dot = realpathSync(join(canonicalRoot, ".trellis"));
    if (!statSync(dot).isDirectory() || !isPathInside(canonicalRoot, dot)) return null;
    const tasks = realpathSync(join(dot, "tasks"));
    if (!statSync(tasks).isDirectory() || !isPathInside(dot, tasks)) return null;
    return tasks;
  } catch {
    return null;
  }
}

function readRuntimeRef(sessionDir: string, key: string): string | null {
  const candidate = join(sessionDir, `${key}.json`);
  let sessionFile: string;
  let data: unknown;
  try {
    sessionFile = realpathSync(candidate);
    if (!isPathInside(sessionDir, sessionFile) || !statSync(sessionFile).isFile()) return null;
    data = JSON.parse(readFileSync(sessionFile, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const ref = typeof (data as Record<string, unknown>).current_task === "string"
    ? ((data as Record<string, unknown>).current_task as string).trim()
    : "";
  return ref || null;
}

function soleSessionRef(sessionDir: string): { key: string; ref: string } | null {
  try {
    if (!existsSync(sessionDir) || !statSync(sessionDir).isDirectory()) return null;
    const sessionFiles = readdirSync(sessionDir).filter((file) => file.endsWith(".json"));
    if (sessionFiles.length !== 1) return null;
    const key = sessionFiles[0].slice(0, -".json".length);
    const ref = readRuntimeRef(sessionDir, key);
    return ref ? { key, ref } : null;
  } catch {
    return null;
  }
}

/** Parse `task.json` in a task dir into a narrowed object, or null. */
export function readTaskJson(taskDir: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    const canonicalTaskDir = realpathSync(taskDir);
    const taskJson = realpathSync(join(canonicalTaskDir, "task.json"));
    if (!isPathInside(canonicalTaskDir, taskJson) || !statSync(taskJson).isFile()) return null;
    data = JSON.parse(readFileSync(taskJson, "utf8"));
  } catch {
    return null;
  }
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function pathSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function sessionDirectorySignature(root: string): string {
  try {
    const dotTrellis = realpathSync(join(root, ".trellis"));
    if (!isPathInside(root, dotTrellis)) return "unsafe";
    const sessionDir = realpathSync(join(dotTrellis, ".runtime", "sessions"));
    if (!isPathInside(dotTrellis, sessionDir) || !statSync(sessionDir).isDirectory()) return "unsafe";
    return readdirSync(sessionDir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => {
        try {
          const sessionFile = realpathSync(join(sessionDir, file));
          return `${file}:${isPathInside(sessionDir, sessionFile) ? pathSignature(sessionFile) : "unsafe"}`;
        } catch {
          return `${file}:unreadable`;
        }
      })
      .join(",");
  } catch {
    return "missing";
  }
}

function computeFingerprint(snapshot: BoardSnapshot, identity: SessionIdentity): string {
  const items = snapshot.checklist?.items.map(
    (item) => `${item.line}:${item.checked ? "x" : " "}:${item.normalized}`,
  ) ?? [];
  const materialFiles = ["prd.md", "design.md", "implement.md", "implement.jsonl", "check.jsonl"].map((name) => {
    const path = snapshot.taskPath ? join(snapshot.taskPath, name) : "";
    return `${name}:${path ? pathSignature(path) : "missing"}`;
  });
  return hash(JSON.stringify({
    root: snapshot.root,
    sessionId: identity.sessionId || null,
    transcriptPath: identity.transcriptPath || null,
    sessions: snapshot.root ? sessionDirectorySignature(snapshot.root) : "missing",
    contextKey: snapshot.contextKey || null,
    taskPath: snapshot.taskPath,
    statusRaw: snapshot.statusRaw,
    planning: snapshot.planning,
    reason: snapshot.reason,
    items,
    materialFiles,
  }));
}

function finish(snapshot: BoardSnapshot, identity: SessionIdentity): BoardSnapshot {
  snapshot.fingerprint = computeFingerprint(snapshot, identity);
  return snapshot;
}

/**
 * Load a board snapshot from one explicit Trellis root. No ancestor selection
 * occurs here, allowing aggregate state to resolve the same Pi identity across
 * every discovered root without changing the single-root compatibility API.
 */
export function loadSnapshotAtRoot(
  rootInput: string,
  identity: SessionIdentity,
  trusted: boolean,
  options: { allowSoleSessionFallback?: boolean } = {},
): BoardSnapshot {
  if (!trusted) return { available: false, degraded: false, reason: "untrusted" };

  let root: string;
  try {
    root = realpathSync(rootInput);
  } catch {
    return finish({ available: false, degraded: true, reason: "not-trellis", root: resolve(rootInput) }, identity);
  }
  if (!hasTrellisDirectory(root)) {
    return finish({ available: false, degraded: false, reason: "not-trellis", root }, identity);
  }
  const tasksDir = canonicalTasksDir(root);
  if (!tasksDir) return finish({ available: false, degraded: true, reason: "no-tasks-dir", root }, identity);

  let sessionDir = join(root, ".trellis", ".runtime", "sessions");
  if (existsSync(sessionDir)) {
    try {
      const dotTrellis = realpathSync(join(root, ".trellis"));
      sessionDir = realpathSync(sessionDir);
      if (!isPathInside(dotTrellis, sessionDir) || !statSync(sessionDir).isDirectory()) {
        return finish({ available: false, degraded: true, reason: "session-outside-root", root }, identity);
      }
    } catch {
      return finish({ available: false, degraded: true, reason: "session-outside-root", root }, identity);
    }
  }
  let resolvedSession: { key: string; ref: string } | null = null;
  let sourceType: "session" | "session-fallback" = "session";
  for (const key of resolveContextKeys(identity)) {
    const ref = readRuntimeRef(sessionDir, key);
    if (ref) {
      resolvedSession = { key, ref };
      break;
    }
  }
  if (!resolvedSession && options.allowSoleSessionFallback !== false) {
    const fallback = soleSessionRef(sessionDir);
    if (fallback) {
      resolvedSession = fallback;
      sourceType = "session-fallback";
    }
  }
  if (!resolvedSession) {
    return finish({ available: false, degraded: true, reason: "no-session", root }, identity);
  }

  const candidate = resolveTaskDir(root, resolvedSession.ref);
  if (!candidate) {
    return finish({ available: false, degraded: true, reason: "bad-task-ref", root, contextKey: resolvedSession.key }, identity);
  }

  let taskPath: string;
  try {
    taskPath = realpathSync(candidate);
  } catch {
    return finish({ available: false, degraded: true, reason: "missing-task-dir", root, contextKey: resolvedSession.key }, identity);
  }
  if (!isPathInside(tasksDir, taskPath)) {
    return finish({ available: false, degraded: true, reason: "task-outside-tasks", root, contextKey: resolvedSession.key }, identity);
  }

  const taskData = readTaskJson(taskPath);
  if (!taskData) {
    return finish({
      available: false,
      degraded: true,
      reason: existsSync(join(taskPath, "task.json")) ? "bad-task-json" : "missing-task-json",
      root,
      contextKey: resolvedSession.key,
      taskPath,
    }, identity);
  }

  const statusRaw = typeof taskData.status === "string" ? taskData.status : "";
  const taskName =
    (typeof taskData.title === "string" && taskData.title) ||
    (typeof taskData.name === "string" && taskData.name) ||
    (typeof taskData.id === "string" && taskData.id) ||
    "";
  const taskId = typeof taskData.id === "string" ? taskData.id : taskPath.split(/[\\/]/).pop() || "";
  const planning = statusRaw === "planning";
  let checklist: ChecklistParseResult | null = null;
  if (!planning) {
    const implementPath = join(taskPath, "implement.md");
    try {
      if (existsSync(implementPath)) {
        const realImplementPath = realpathSync(implementPath);
        if (isPathInside(taskPath, realImplementPath) && statSync(realImplementPath).isFile()) {
          checklist = parseChecklist(readFileSync(realImplementPath, "utf8"));
        }
      }
    } catch {
      checklist = null;
    }
  }

  return finish({
    available: true,
    degraded: false,
    root,
    contextKey: resolvedSession.key,
    sourceType,
    taskPath,
    taskId,
    taskName,
    statusRaw,
    planning,
    checklist,
  }, identity);
}

/** Load the current snapshot from the nearest Trellis ancestor (legacy API). */
export function loadSnapshot(cwd: string, identity: SessionIdentity, trusted: boolean): BoardSnapshot {
  if (!trusted) return { available: false, degraded: false, reason: "untrusted" };
  const root = findTrellisRoot(cwd);
  if (!root) return { available: false, degraded: false, reason: "not-trellis" };
  return loadSnapshotAtRoot(root, identity, trusted);
}
