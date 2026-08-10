/**
 * Trusted Trellis project discovery, session-key compatibility, current-task
 * resolution and canonical path containment.
 *
 * This module is pure Node (fs / crypto / path only) so it can be unit-tested
 * standalone. It never imports private code from the project's managed Pi
 * Trellis extension; it re-implements the two known session-key algorithms
 * (the current Pi extension writer and the Python runtime normalizer) and
 * reads only the runtime session files and the task files they point at.
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
  /** A trusted Trellis project with a uniquely resolvable current task. */
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

/**
 * Ordered session-key candidates for the current Pi session.
 * Primary: the current Pi extension writer's `contextKey()` algorithm.
 * Secondary: the Python `active_task.py` normalized candidate (version tolerance).
 * All candidates are deduplicated preserving priority order.
 */
export function resolveContextKeys(id: SessionIdentity): string[] {
  const keys: string[] = [];
  const sessionId = id.sessionId ? id.sessionId.trim() : "";
  if (sessionId) {
    const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (!normalized) {
      keys.push(`pi_${hash(sessionId)}`);
    } else {
      keys.push(`pi_${normalized}${normalized === sessionId ? "" : `_${hash(sessionId)}`}`);
    }
    const safe = sanitizeKey(sessionId);
    keys.push(safe ? `pi_${safe}` : `pi_${hash(sessionId)}`);
  }
  const transcriptPath = id.transcriptPath ? id.transcriptPath.trim() : "";
  if (transcriptPath) {
    keys.push(`pi_transcript_${hash(transcriptPath)}`);
  }
  return [...new Set(keys)];
}

/** Walk upward from cwd to the nearest ancestor containing a `.trellis/` directory. */
export function findTrellisRoot(cwd: string): string | null {
  let cur = resolve(cwd);
  let guard = 0;
  for (;;) {
    const dot = join(cur, ".trellis");
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isDirectory()) {
          try {
            return realpathSync(cur);
          } catch {
            return cur;
          }
        }
      } catch {
        /* fall through to parent */
      }
    }
    const parent = dirname(cur);
    if (parent === cur || guard > 1000) return null;
    cur = parent;
    guard++;
  }
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

/** Canonical (realpath) `.trellis/tasks` dir for a Trellis root, or null. */
export function canonicalTasksDir(root: string): string | null {
  const d = join(root, ".trellis", "tasks");
  if (!existsSync(d)) return null;
  try {
    if (!statSync(d).isDirectory()) return null;
    return realpathSync(d);
  } catch {
    return null;
  }
}

function readRuntimeRef(sessionDir: string, key: string): string | null {
  const p = join(sessionDir, `${key}.json`);
  if (!existsSync(p)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const ref = typeof rec.current_task === "string" ? rec.current_task.trim() : "";
  return ref || null;
}

function soleSessionRef(sessionDir: string): { key: string; ref: string } | null {
  if (!existsSync(sessionDir)) return null;
  let entries: string[];
  try {
    if (!statSync(sessionDir).isDirectory()) return null;
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const sessionFiles = entries.filter((f) => f.endsWith(".json"));
  if (sessionFiles.length !== 1) return null;
  const key = sessionFiles[0].slice(0, -".json".length);
  const ref = readRuntimeRef(sessionDir, key);
  return ref ? { key, ref } : null;
}

/** Parse `task.json` in a task dir into a narrowed object, or null. */
export function readTaskJson(taskDir: string): Record<string, unknown> | null {
  const p = join(taskDir, "task.json");
  if (!existsSync(p)) return null;
  let data: unknown;
  try {
    if (!statSync(p).isFile()) return null;
    data = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function computeFingerprint(s: BoardSnapshot, identity: SessionIdentity): string {
  const items =
    s.checklist?.items.map((i) => `${i.line}:${i.checked ? "x" : " "}:${i.normalized}`) ?? [];
  const materialFiles = ["prd.md", "design.md", "implement.md", "implement.jsonl", "check.jsonl"].map((name) => {
    const path = s.taskPath ? join(s.taskPath, name) : "";
    if (!path || !existsSync(path)) return `${name}:missing`;
    try {
      const stat = statSync(path);
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${name}:unreadable`;
    }
  });
  const repr = JSON.stringify({
    root: s.root,
    sessionId: identity.sessionId || null,
    contextKey: s.contextKey || null,
    taskPath: s.taskPath,
    statusRaw: s.statusRaw,
    planning: s.planning,
    items,
    materialFiles,
  });
  return hash(repr);
}

/**
 * Load the current Trellis board snapshot for a session.
 *
 * - Untrusted projects and non-Trellis dirs deactivate quietly.
 * - Candidate keys are tried in priority order; zero candidates fall back to
 *   Trellis's sole-session semantics; multiple sessions are never guessed.
 * - The task directory must resolve, as a realpath, inside `.trellis/tasks`.
 */
export function loadSnapshot(cwd: string, identity: SessionIdentity, trusted: boolean): BoardSnapshot {
  if (!trusted) {
    return { available: false, degraded: false, reason: "untrusted" };
  }
  const root = findTrellisRoot(cwd);
  if (!root) {
    return { available: false, degraded: false, reason: "not-trellis" };
  }
  const tasksDir = canonicalTasksDir(root);
  if (!tasksDir) {
    return { available: false, degraded: true, reason: "no-tasks-dir", root };
  }

  const sessionDir = join(root, ".trellis", ".runtime", "sessions");
  let resolved: { key: string; ref: string } | null = null;
  let sourceType: "session" | "session-fallback" = "session";
  for (const key of resolveContextKeys(identity)) {
    const ref = readRuntimeRef(sessionDir, key);
    if (ref) {
      resolved = { key, ref };
      break;
    }
  }
  if (!resolved) {
    const fb = soleSessionRef(sessionDir);
    if (fb) {
      resolved = fb;
      sourceType = "session-fallback";
    }
  }
  if (!resolved) {
    return { available: false, degraded: true, reason: "no-session", root };
  }

  const candidate = resolveTaskDir(root, resolved.ref);
  if (!candidate) {
    return { available: false, degraded: true, reason: "bad-task-ref", root, contextKey: resolved.key };
  }

  let realTaskDir: string;
  try {
    realTaskDir = realpathSync(candidate);
  } catch {
    return { available: false, degraded: true, reason: "missing-task-dir", root, contextKey: resolved.key };
  }
  if (!isPathInside(tasksDir, realTaskDir)) {
    return { available: false, degraded: true, reason: "task-outside-tasks", root, contextKey: resolved.key };
  }

  const taskData = readTaskJson(realTaskDir);
  if (!taskData) {
    return {
      available: false,
      degraded: true,
      reason: taskData === null && !existsSync(join(realTaskDir, "task.json")) ? "missing-task-json" : "bad-task-json",
      root,
      contextKey: resolved.key,
      taskPath: realTaskDir,
    };
  }

  const statusRaw = typeof taskData.status === "string" ? taskData.status : "";
  const taskName =
    (typeof taskData.title === "string" && taskData.title) ||
    (typeof taskData.name === "string" && taskData.name) ||
    (typeof taskData.id === "string" && taskData.id) ||
    "";
  const taskId = typeof taskData.id === "string" ? taskData.id : realTaskDir.split(/[\\/]/).pop() || "";

  const planning = statusRaw === "planning";
  let checklist: ChecklistParseResult | null = null;
  if (!planning) {
    const implPath = join(realTaskDir, "implement.md");
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

  const snapshot: BoardSnapshot = {
    available: true,
    degraded: false,
    root,
    contextKey: resolved.key,
    sourceType,
    taskPath: realTaskDir,
    taskId,
    taskName,
    statusRaw,
    planning,
    checklist,
  };
  snapshot.fingerprint = computeFingerprint(snapshot, identity);
  return snapshot;
}