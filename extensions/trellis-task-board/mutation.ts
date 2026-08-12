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
import { isPathInside, type SessionIdentity } from "./task-state.ts";
import { loadWritableSnapshot } from "./aggregate-state.ts";
import { formatReason } from "./ui.ts";

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
  const snap = loadWritableSnapshot(cwd, identity, trusted);
  if (!snap.available) {
    if (snap.reason === "untrusted") return Promise.resolve(err("项目不受信任；看板未激活。"));
    if (snap.reason === "ambiguous-active-binding") {
      return Promise.resolve(err("当前会话在多个 Trellis 根中绑定任务；拒绝猜测或写入。"));
    }
    return Promise.resolve(err("当前会话未绑定执行任务；无法修改。"));
  }
  if (snap.degraded) {
    return Promise.resolve(err(`看板异常（${formatReason(snap.reason)}）；请运行 list 获取最新快照。`));
  }
  if (snap.planning) {
    return Promise.resolve(err("任务处于规划阶段；检查清单尚未可执行。"));
  }
  if (!snap.checklist || snap.checklist.mode !== "checkbox") {
    return Promise.resolve(err("无可变复选框清单（旧式或无）；只读。"));
  }
  if (!snap.taskPath) {
    return Promise.resolve(err("无规范任务路径。"));
  }

  const implPath = join(snap.taskPath, "implement.md");
  if (!existsSync(implPath) || !statSync(implPath).isFile()) {
    return Promise.resolve(err("任务中缺少 implement.md；无法修改。"));
  }
  let realImpl: string;
  try {
    realImpl = realpathSync(implPath);
  } catch {
    return Promise.resolve(err("无法解析 implement.md。"));
  }
  if (!isPathInside(snap.taskPath, realImpl)) {
    return Promise.resolve(err("implement.md 超出规范任务目录。"));
  }

  return withFileMutationQueue(realImpl, async () => {
    const live = loadWritableSnapshot(cwd, identity, trusted);
    if (!live.available || !live.taskPath || !live.checklist || live.checklist.mode !== "checkbox") {
      return err("状态已过期；请运行 list 获取最新快照。");
    }
    if (live.planning) {
      return err("任务已回到规划阶段；请运行 list 获取最新快照。");
    }
    // Re-derive the canonical implement.md from the freshly resolved task and
    // require it to still be the file this queue is locked on.
    const liveImpl = join(live.taskPath, "implement.md");
    let liveImplReal: string;
    try {
      liveImplReal = realpathSync(liveImpl);
    } catch {
      return err("implement 路径已过期；请运行 list 获取最新快照。");
    }
    if (liveImplReal !== realImpl || !isPathInside(live.taskPath, liveImplReal)) {
      return err("当前任务已变更；请运行 list 获取最新快照。");
    }

    const current = readFileSync(realImpl, "utf8");
    const parsed = parseChecklist(current);
    if (parsed.mode !== "checkbox") {
      return err("implement.md 已无复选框清单；请运行 list。");
    }
    // Match by one-based item number against the ordered mutable checkbox list.
    const mutable = parsed.items.filter((it) => it.kind === "checkbox");
    if (params.item < 1 || params.item > mutable.length) {
      return err(`条目 ${params.item} 超出范围（1..${mutable.length}）；请运行 list。`);
    }
    const target = mutable[params.item - 1];
    if (target.normalized !== normalizeText(params.expectedText)) {
      return err(`条目 ${params.item} 文本不匹配；请运行 list 查看当前看板。`);
    }

    const { text: nextText, changed } = applyMarkerChange(current, target, params.completed);
    if (!changed) {
      return ok(`条目 ${params.item} 已处于请求状态。`, false);
    }
    writeFileSync(realImpl, nextText, "utf8");
    return ok(`已更新条目 ${params.item}。`, true);
  });
}