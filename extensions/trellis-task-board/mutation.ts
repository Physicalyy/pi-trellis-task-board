/**
 * Constrained checkbox mutation for `trellis_task_board.set_completed`.
 *
 * The entire read-validate-write window runs inside
 * `withFileMutationQueue(realImplementPath)` so the operation participates in
 * the same per-file queue as the built-in `edit`/`write` tools. The project,
 * session, task and file are re-resolved and re-parsed inside the queue, and
 * the one-based item plus expected text must still match before any write.
 *
 * This module is the package's only write boundary beyond Trellis-managed
 * files: it changes exactly one ASCII checkbox marker in an existing canonical
 * `implement.md` inside `.trellis/tasks/`. It never creates files and never
 * accepts an arbitrary path.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyMarkerChange, normalizeText, parseChecklist } from "./checklist.ts";
import { isPathInside, loadSnapshot, type SessionIdentity } from "./task-state.ts";

export interface SetCompletedParams {
  item: number;
  expectedText: string;
  completed: boolean;
}

export interface SetCompletedResult {
  ok: boolean;
  message: string;
  changed?: boolean;
}

function ok(message: string, changed?: boolean): SetCompletedResult {
  return { ok: true, message, changed };
}
function err(message: string): SetCompletedResult {
  return { ok: false, message };
}

export function setCompleted(
  cwd: string,
  identity: SessionIdentity,
  trusted: boolean,
  params: SetCompletedParams,
): Promise<SetCompletedResult> {
  // Read-only pre-flight: cheap rejection before entering the mutation queue.
  const snap = loadSnapshot(cwd, identity, trusted);
  if (!snap.available) {
    return Promise.resolve(
      err(snap.reason === "untrusted" ? "Not a trusted project; board inactive." : "No current task; board inactive."),
    );
  }
  if (snap.degraded) {
    return Promise.resolve(err(`Board degraded (${snap.reason}); run list for a fresh snapshot.`));
  }
  if (snap.planning) {
    return Promise.resolve(err("Task is in planning; checklist is not execution-ready."));
  }
  if (!snap.checklist || snap.checklist.mode !== "checkbox") {
    return Promise.resolve(err("No mutable checkbox checklist (legacy or none); read-only."));
  }
  if (!snap.taskPath) {
    return Promise.resolve(err("No canonical task path."));
  }

  const implPath = join(snap.taskPath, "implement.md");
  if (!existsSync(implPath) || !statSync(implPath).isFile()) {
    return Promise.resolve(err("implement.md missing in task; cannot mutate."));
  }
  let realImpl: string;
  try {
    realImpl = realpathSync(implPath);
  } catch {
    return Promise.resolve(err("implement.md not resolvable."));
  }
  if (!isPathInside(snap.taskPath, realImpl)) {
    return Promise.resolve(err("implement.md escapes the canonical task directory."));
  }

  return withFileMutationQueue(realImpl, async () => {
    const live = loadSnapshot(cwd, identity, trusted);
    if (!live.available || !live.taskPath || !live.checklist || live.checklist.mode !== "checkbox") {
      return err("Stale state; run list for a fresh snapshot.");
    }
    if (live.planning) {
      return err("Task moved to planning; run list for a fresh snapshot.");
    }
    // Re-derive the canonical implement.md from the freshly resolved task and
    // require it to still be the file this queue is locked on.
    const liveImpl = join(live.taskPath, "implement.md");
    let liveImplReal: string;
    try {
      liveImplReal = realpathSync(liveImpl);
    } catch {
      return err("Stale implement path; run list for a fresh snapshot.");
    }
    if (liveImplReal !== realImpl || !isPathInside(live.taskPath, liveImplReal)) {
      return err("Active task changed; run list for a fresh snapshot.");
    }

    const current = readFileSync(realImpl, "utf8");
    const parsed = parseChecklist(current);
    if (parsed.mode !== "checkbox") {
      return err("implement.md no longer has a checkbox checklist; run list.");
    }
    // Match by one-based item number against the ordered mutable checkbox list.
    const mutable = parsed.items.filter((it) => it.kind === "checkbox");
    if (params.item < 1 || params.item > mutable.length) {
      return err(`Item ${params.item} out of range (1..${mutable.length}); run list.`);
    }
    const target = mutable[params.item - 1];
    if (target.normalized !== normalizeText(params.expectedText)) {
      return err(`Item ${params.item} text mismatch; run list for the current board.`);
    }

    const { text: nextText, changed } = applyMarkerChange(current, target, params.completed);
    if (!changed) {
      return ok(`Item ${params.item} already in requested state.`, false);
    }
    writeFileSync(realImpl, nextText, "utf8");
    return ok(`Updated item ${params.item}.`, true);
  });
}