/** Pure ANSI/CJK-width-safe formatting for widget and full-list surfaces. */

import { basename } from "node:path";
import type { ChecklistItem } from "./checklist.ts";
import type { BoardSnapshot } from "./task-state.ts";
import {
  isAggregate,
  sortRepositories,
  type ActiveBinding,
  type AggregateBoardSnapshot,
  type BoardView,
  type RepositorySnapshot,
  type RepositoryTaskSnapshot,
} from "./aggregate-state.ts";

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function isZeroWidth(cp: number): boolean {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f);
}

export function visibleWidth(text: string): number {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  let width = 0;
  for (const character of Array.from(clean)) {
    const cp = character.codePointAt(0)!;
    if (!isZeroWidth(cp)) width += isWide(cp) ? 2 : 1;
  }
  return width;
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let output = "";
  for (const character of Array.from(text)) {
    const cp = character.codePointAt(0)!;
    if (isZeroWidth(cp)) {
      output += character;
      continue;
    }
    const characterWidth = isWide(cp) ? 2 : 1;
    if (used + characterWidth > width) break;
    used += characterWidth;
    output += character;
  }
  return output;
}

export function formatReason(reason?: string): string {
  const messages: Record<string, string> = {
    untrusted: "项目不受信任",
    "not-trellis": "不是 Trellis 项目",
    "no-tasks-dir": "缺少或不安全的 .trellis/tasks 目录",
    "no-session": "当前会话未绑定执行任务",
    "session-outside-root": "会话目录超出安全范围",
    "ambiguous-active-binding": "当前会话在多个 Trellis 根中绑定任务",
    "bad-task-ref": "当前任务引用无效",
    "missing-task-dir": "当前任务目录不存在",
    "task-outside-tasks": "当前任务超出安全目录",
    "missing-task-json": "缺少 task.json",
    "bad-task-json": "task.json 无效",
  };
  return reason ? messages[reason] ?? reason : "看板不可用";
}

export function formatStatus(snapshot: BoardSnapshot): string {
  const raw = snapshot.statusRaw ?? "";
  if (snapshot.planning) return "规划 · 阶段 1 · 等待激活";
  if (raw === "in_progress") {
    const checklist = snapshot.checklist;
    return checklist?.mode === "checkbox" && checklist.total > 0
      ? `进行中 · 阶段 2/3 · ${checklist.completed}/${checklist.total}`
      : "进行中 · 阶段 2/3";
  }
  if (raw === "completed") return "已完成 · 阶段 3";
  if (raw === "review") return "评审中";
  return raw ? raw.replace(/[-_]+/g, " ").toUpperCase() : "未知状态";
}

export interface CompactWindow {
  items: ChecklistItem[];
  /** index of the first pending item inside the returned source-contiguous slice */
  currentIndex: number;
  omitted: number;
  hiddenBefore: number;
  hiddenAfter: number;
  /** compatibility alias: pending rows hidden after the slice */
  hiddenPending: number;
}

/** Select one source-contiguous slice focused on the first unchecked item. */
export function selectCompactWindow(items: ChecklistItem[], maxRows: number): CompactWindow {
  const capacity = Math.max(0, maxRows);
  if (items.length === 0 || capacity === 0) {
    return { items: [], currentIndex: -1, omitted: items.length, hiddenBefore: 0, hiddenAfter: items.length, hiddenPending: 0 };
  }
  const firstPending = items.findIndex((item) => item.kind === "checkbox" && !item.checked);
  const start = firstPending < 0
    ? Math.max(0, items.length - capacity)
    : Math.max(0, Math.min(firstPending - Math.floor((capacity - 1) / 2), items.length - capacity));
  const end = Math.min(items.length, start + capacity);
  const slice = items.slice(start, end);
  return {
    items: slice,
    currentIndex: firstPending < 0 ? -1 : firstPending - start,
    omitted: items.length - slice.length,
    hiddenBefore: start,
    hiddenAfter: items.length - end,
    hiddenPending: items.slice(end).filter((item) => item.kind === "checkbox" && !item.checked).length,
  };
}

type RowStatus = "completed" | "pending-first" | "pending-later" | "active" | "future" | "legacy" | "malformed";

function checklistStatus(item: ChecklistItem, firstPending: boolean): RowStatus {
  if (item.kind === "legacy") return "legacy";
  if (item.kind === "malformed") return "malformed";
  if (item.checked) return "completed";
  return firstPending ? "pending-first" : "pending-later";
}

function rowGlyph(status: RowStatus): string {
  if (status === "completed") return "✓";
  if (status === "pending-first" || status === "pending-later" || status === "future") return "□";
  if (status === "active") return "→";
  if (status === "legacy") return "·";
  return "?";
}

function treePrefix(index: number, total: number): string {
  if (total <= 1) return "";
  return index === total - 1 ? "└─ " : "├─ ";
}

/** Theme callbacks; all are optional except legacy-compatible core hooks. */
export interface WidgetStyler {
  dim(text: string): string;
  strike(text: string): string;
  highlight(text: string): string;
  accent?(text: string): string;
  text?(text: string): string;
  muted?(text: string): string;
  bold?(text: string): string;
  warning?(text: string): string;
  error?(text: string): string;
}

export interface WidgetRenderOptions {
  width?: number;
  maxRows?: number;
  style?: WidgetStyler;
}

function applyStatus(text: string, status: RowStatus, style?: WidgetStyler): string {
  if (!style) return text;
  if (status === "completed") return style.dim(style.strike(text));
  if (status === "active") return style.highlight(text);
  return text;
}

function fitBody(body: string, width: number): string {
  if (visibleWidth(body) <= width) return body;
  return width <= 1 ? truncateToWidth(body, width) : `${truncateToWidth(body, width - 1)}…`;
}

/**
 * Style checklist segments independently after budgeting the complete plain
 * row. This gives every □ an accent while keeping later pending text plain.
 */
function renderChecklistRow(
  prefix: string,
  item: ChecklistItem,
  status: RowStatus,
  suffix: string,
  width: number,
  style?: WidgetStyler,
): string {
  const glyph = rowGlyph(status);
  const separator = suffix ? "  " : "";
  const fixed = `${prefix}${glyph} `;
  const bodyBudget = Math.max(0, width - visibleWidth(fixed) - visibleWidth(separator) - visibleWidth(suffix));
  const body = fitBody(item.normalized || item.text || "(empty)", bodyBudget);
  if (!style) return `${fixed}${body}${separator}${suffix}`;

  const styledPrefix = style.muted?.(prefix) ?? prefix;
  let styledGlyph = glyph;
  let styledBody = body;
  if (status === "completed") {
    styledGlyph = style.dim(glyph);
    styledBody = style.dim(style.strike(body));
  } else if (status === "pending-first" || status === "pending-later") {
    styledGlyph = style.accent?.(glyph) ?? glyph;
    if (status === "pending-first") {
      const accentBody = style.accent?.(body) ?? body;
      styledBody = style.bold?.(accentBody) ?? style.highlight(body);
    } else styledBody = style.text?.(body) ?? body;
  }
  const styledSuffix = suffix ? (style.muted?.(suffix) ?? style.dim(suffix)) : "";
  return `${styledPrefix}${styledGlyph} ${styledBody}${separator}${styledSuffix}`;
}

function header(title: string, status: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(status));
  return truncateToWidth(`${title}${" ".repeat(gap)}${status}`, width).trimEnd();
}

export function renderSingleWidgetLines(snapshot: BoardSnapshot, options: WidgetRenderOptions = {}): string[] {
  const width = options.width ?? 80;
  const maxRows = options.maxRows ?? 3;
  const style = options.style;
  const lines = [header("trellis-task-board", snapshot.degraded ? "!" : formatStatus(snapshot), width)];
  if (snapshot.degraded) {
    lines.push(style?.warning?.(truncateToWidth(`! ${formatReason(snapshot.reason)}`, width)) ?? truncateToWidth(`! ${formatReason(snapshot.reason)}`, width));
    return lines;
  }
  if (!snapshot.available) {
    lines.push(style?.muted?.("· 未激活（无受信任的 Trellis 任务）") ?? "· 未激活（无受信任的 Trellis 任务）");
    return lines;
  }
  if (snapshot.planning) return [...lines, "· PRD / Design / Plan / 上下文材料", "· 等待任务激活（状态：planning）"];
  const checklist = snapshot.checklist;
  if (!checklist || checklist.items.length === 0) return [...lines, "· 无机器可读的检查清单"];
  if (checklist.mode === "legacy") {
    checklist.items.slice(0, maxRows).forEach((item) => lines.push(truncateToWidth(`· ${item.text}`, width)));
    return lines;
  }

  const window = selectCompactWindow(checklist.items, maxRows);
  const firstPending = checklist.items.findIndex((item) => item.kind === "checkbox" && !item.checked);
  window.items.forEach((item, index) => {
    const sourceIndex = window.hiddenBefore + index;
    const status = checklistStatus(item, sourceIndex === firstPending);
    const suffix = index === window.items.length - 1 && window.hiddenAfter > 0 ? `… 还有 ${window.hiddenAfter} 项` : "";
    lines.push(renderChecklistRow(treePrefix(index, window.items.length), item, status, suffix, width, style));
  });
  return lines;
}

export function renderSingleFullListLines(
  snapshot: BoardSnapshot,
  options: { width?: number; style?: WidgetStyler } = {},
): string[] {
  const width = options.width ?? 100;
  const out = [truncateToWidth(`trellis-task-board  ${snapshot.available ? "·" : ""} ${snapshot.degraded ? "!" : formatStatus(snapshot)}`, width)];
  if (snapshot.degraded) return [...out, truncateToWidth(`  ! ${formatReason(snapshot.reason)}`, width)];
  if (!snapshot.available) return [...out, truncateToWidth("  未激活：无受信任的 Trellis 任务。", width)];
  const name = snapshot.taskName || snapshot.taskId || "(未命名任务)";
  out.push(truncateToWidth(`  任务：${snapshot.taskId ? `${snapshot.taskId} — ` : ""}${name}`, width));
  out.push(truncateToWidth(`  状态：${snapshot.statusRaw ?? "unknown"}`, width), "");
  if (snapshot.planning) return [...out, "  阶段 1 · 规划", "  门禁：PRD / Design / Plan / 上下文材料", "  等待任务激活（状态：planning）", "", "  规划阶段不显示执行进度。"];
  const checklist = snapshot.checklist;
  if (!checklist || checklist.items.length === 0) return [...out, "  无机器可读的执行检查清单。", "  进度不可计算。"];
  if (checklist.mode === "legacy") {
    out.push("  旧式编号计划 — 进度不可计算（只读）。", "");
    checklist.items.forEach((item, index) => out.push(truncateToWidth(`  ${index + 1}. ${item.text}`, width)));
    return out;
  }
  const firstPending = checklist.items.findIndex((item) => item.kind === "checkbox" && !item.checked);
  checklist.items.forEach((item, index) => {
    out.push(renderChecklistRow("  ", item, checklistStatus(item, index === firstPending), "", width, options.style));
  });
  return out;
}

export function renderWidgetLines(view: BoardView, options?: WidgetRenderOptions): string[] {
  return isAggregate(view) ? renderAggregateWidgetLines(view, options) : renderSingleWidgetLines(view, options);
}

export function renderFullListLines(view: BoardView, options?: { width?: number; style?: WidgetStyler }): string[] {
  return isAggregate(view) ? renderAggregateFullListLines(view, options) : renderSingleFullListLines(view, options);
}

export const MAX_AGGREGATE_WIDGET_ROWS = 8;

function lifecycle(status: string): string {
  if (status === "in_progress") return "进行中";
  if (status === "planning") return "规划中";
  if (status === "completed") return "已完成";
  if (status === "review") return "评审中";
  return status ? status.replace(/[-_]+/g, " ").toUpperCase() : "未知";
}

function taskStatus(task: RepositoryTaskSnapshot): string {
  const base = lifecycle(task.statusRaw);
  if (task.checklist?.mode === "checkbox" && task.checklist.total > 0) return `${base} · ${task.checklist.completed}/${task.checklist.total}`;
  return task.statusRaw === "in_progress" ? `${base} · 进度不可计算` : base;
}

function snapshotStatus(snapshot: BoardSnapshot): string {
  const base = lifecycle(snapshot.statusRaw ?? "");
  if (snapshot.checklist?.mode === "checkbox" && snapshot.checklist.total > 0) return `${base} · ${snapshot.checklist.completed}/${snapshot.checklist.total}`;
  return base;
}

export function truncateStructuredRow(prefix: string, body: string, suffix: string, width: number): string {
  const separator = suffix ? " · " : "";
  const fixedWidth = visibleWidth(prefix) + visibleWidth(separator) + visibleWidth(suffix);
  if (fixedWidth >= width) {
    const safePrefix = truncateToWidth(prefix, width);
    return `${safePrefix}${truncateToWidth(suffix, Math.max(0, width - visibleWidth(safePrefix)))}`.trimEnd();
  }
  return `${prefix}${fitBody(body, width - fixedWidth)}${separator}${suffix}`;
}

function repositorySuffix(repository: RepositorySnapshot, hiddenActive = 0): string {
  if (repository.counts.total === 0) return "无任务";
  let result = `${repository.counts.completed}/${repository.counts.total} 完成`;
  if (hiddenActive > 0) result += ` · 进行中 ${hiddenActive} 项`;
  else if (repository.counts.inProgress === 0 && repository.counts.planning > 0) result += ` · 规划中 ${repository.counts.planning}`;
  else if (repository.counts.inProgress === 0 && repository.counts.review > 0) result += ` · 评审中 ${repository.counts.review}`;
  else if (repository.counts.inProgress === 0 && repository.counts.unknown > 0) result += ` · 未知 ${repository.counts.unknown}`;
  return result;
}

function taskRowStatus(task: RepositoryTaskSnapshot): RowStatus {
  if (task.statusRaw === "completed") return "completed";
  if (task.statusRaw === "in_progress") return "active";
  if (task.statusRaw === "planning") return "future";
  if (task.checklist?.mode === "legacy") return "legacy";
  return "malformed";
}

function hasProgress(task: RepositoryTaskSnapshot): boolean {
  return Boolean(task.checklist?.mode === "checkbox" && task.checklist.total > 0);
}

function aggregateCounts(view: AggregateBoardSnapshot): { completed: number; total: number } {
  const rootCounts = view.workspaceRepository?.counts;
  return view.repositories.reduce((counts, repository) => ({
    completed: counts.completed + repository.counts.completed,
    total: counts.total + repository.counts.total,
  }), { completed: rootCounts?.completed ?? 0, total: rootCounts?.total ?? 0 });
}

function binding(view: AggregateBoardSnapshot): ActiveBinding {
  if (view.activeBinding) return view.activeBinding;
  return view.workspace.available
    ? { kind: "bound", root: view.root, repository: null, snapshot: view.workspace }
    : { kind: "unbound" };
}

function styleSemantic(text: string, kind: "accent" | "muted" | "warning" | RowStatus, style?: WidgetStyler): string {
  if (!style) return text;
  if (kind === "accent") return style.accent?.(text) ?? text;
  if (kind === "muted") return style.muted?.(text) ?? style.dim(text);
  if (kind === "warning") return style.warning?.(text) ?? text;
  return applyStatus(text, kind, style);
}

export function renderAggregateWidgetLines(view: AggregateBoardSnapshot, options: WidgetRenderOptions = {}): string[] {
  const width = options.width ?? 80;
  const style = options.style;
  const totals = aggregateCounts(view);
  const totalSuffix = totals.total > 0 ? `工作区 ${totals.completed}/${totals.total} 完成` : "工作区无任务";
  const lines = [styleSemantic(truncateStructuredRow("", "trellis-task-board", totalSuffix, width), "accent", style)];
  const active = binding(view);
  let activeChecklist: BoardSnapshot | null = null;
  if (active.kind === "bound") {
    activeChecklist = active.snapshot;
    const repoName = active.repository?.relativePath ?? "工作区根";
    const name = active.snapshot.taskName || active.snapshot.taskId || "(未命名任务)";
    lines.push(styleSemantic(truncateStructuredRow("当前执行 ", `${repoName} / ${name}`, snapshotStatus(active.snapshot), width), "accent", style));
  } else if (active.kind === "ambiguous") {
    lines.push(styleSemantic(truncateToWidth(`! 当前会话在 ${active.bindings.length} 个根中绑定任务（拒绝猜测）`, width), "warning", style));
  } else {
    lines.push(styleSemantic(truncateToWidth("· 当前会话未绑定执行任务", width), "muted", style));
  }

  if (activeChecklist?.checklist?.mode === "checkbox" && !activeChecklist.planning) {
    const remainingBudget = Math.max(0, Math.min(3, MAX_AGGREGATE_WIDGET_ROWS - lines.length));
    const window = selectCompactWindow(activeChecklist.checklist.items, remainingBudget);
    const firstPending = activeChecklist.checklist.items.findIndex((item) => item.kind === "checkbox" && !item.checked);
    window.items.forEach((item, index) => {
      const sourceIndex = window.hiddenBefore + index;
      const suffix = index === window.items.length - 1 && window.hiddenAfter > 0 ? `… 还有 ${window.hiddenAfter} 项` : "";
      lines.push(renderChecklistRow("  ", item, checklistStatus(item, sourceIndex === firstPending), suffix, width, style));
    });
  }

  const diagnostics = view.warnings.slice(0, 1);
  for (const warning of diagnostics) {
    if (lines.length < MAX_AGGREGATE_WIDGET_ROWS) lines.push(styleSemantic(truncateToWidth(`! ${warning.message}`, width), "warning", style));
  }

  const repositories = sortRepositories(view.repositories);
  const available = MAX_AGGREGATE_WIDGET_ROWS - lines.length;
  const needsFold = repositories.length > available;
  const visibleCount = Math.max(0, Math.min(repositories.length, available - (needsFold ? 1 : 0)));
  repositories.slice(0, visibleCount).forEach((repository, index) => {
    const connector = index === visibleCount - 1 ? "└─ " : "├─ ";
    lines.push(truncateStructuredRow(connector, repository.relativePath, repositorySuffix(repository, repository.counts.inProgress), width));
  });
  const folded = repositories.length - visibleCount;
  if (folded > 0) lines.push(styleSemantic(truncateToWidth(`+${folded} 仓库折叠 · /trellis-tasks`, width), "muted", style));
  return lines.slice(0, MAX_AGGREGATE_WIDGET_ROWS);
}

export function renderAggregateFullListLines(
  view: AggregateBoardSnapshot,
  options: { width?: number; style?: WidgetStyler } = {},
): string[] {
  const width = options.width ?? 100;
  const style = options.style;
  const output: string[] = [];
  const push = (line = "", kind?: "accent" | "muted" | "warning" | RowStatus): void => {
    const bounded = truncateToWidth(line, width);
    output.push(kind ? styleSemantic(bounded, kind, style) : bounded);
  };
  const totals = aggregateCounts(view);
  push(`trellis-task-board · 工作区 ${totals.completed}/${totals.total} 完成`, "accent");
  push(`工作区：${view.workspaceRoot ?? view.root}`);
  push(`cwd 所属根：${view.cwdRoot ?? view.root}`, "muted");
  const active = binding(view);
  if (active.kind === "bound") {
    const name = active.snapshot.taskName || active.snapshot.taskId || "(未命名任务)";
    push(`当前执行：${active.repository?.relativePath ?? "工作区根"} / ${name} · ${snapshotStatus(active.snapshot)}`, "accent");
    if (active.snapshot.checklist?.mode === "checkbox") {
      const firstPending = active.snapshot.checklist.items.findIndex((item) => item.kind === "checkbox" && !item.checked);
      active.snapshot.checklist.items.forEach((item, index) => {
        output.push(renderChecklistRow("  ", item, checklistStatus(item, index === firstPending), "", width, style));
      });
    } else push("  进度不可计算", "muted");
  } else if (active.kind === "ambiguous") push(`! 当前会话在 ${active.bindings.length} 个 Trellis 根中绑定任务；写入已禁用`, "warning");
  else push("· 当前会话未绑定执行任务", "muted");
  push();

  const writable = active.kind === "bound" && active.snapshot.checklist?.mode === "checkbox"
    ? active.snapshot.checklist.items.filter((item) => item.kind === "checkbox") : [];
  if (writable.length > 0) {
    push(`可写作用域（set_completed 唯一目标）：${active.kind === "bound" ? active.snapshot.taskId ?? "当前任务" : ""} 的 implement.md`);
    writable.forEach((item, index) => push(`  ${index + 1}. [${item.checked ? "x" : " "}] ${item.text}`));
  } else push("可写作用域：无（未绑定、歧义或无复选框清单）", "muted");
  push();

  view.warnings.forEach((warning) => push(`! ${warning.message}`, "warning"));
  if (view.warnings.length > 0) push();

  const overviewRepositories = [
    ...(view.workspaceRepository ? [view.workspaceRepository] : []),
    ...view.repositories,
  ];
  overviewRepositories.forEach((repository, repositoryIndex) => {
    const rootOverview = repository === view.workspaceRepository;
    const repositoryConnector = repositoryIndex === overviewRepositories.length - 1 ? "└─ " : "├─ ";
    const repositoryLabel = rootOverview ? "工作区根任务（生命周期总览）" : repository.relativePath;
    push(`${repositoryConnector}${repositoryLabel} · ${repositorySuffix(repository)}`);
    push(`   ${rootOverview ? "根任务总览" : "只读仓库"} · completed ${repository.counts.completed} · in_progress ${repository.counts.inProgress} · planning ${repository.counts.planning} · review ${repository.counts.review} · unknown ${repository.counts.unknown}`, "muted");
    repository.tasks.forEach((task, taskIndex) => {
      const status = taskRowStatus(task);
      const connector = taskIndex === repository.tasks.length - 1 ? "└─ " : "├─ ";
      push(`   ${connector}${rowGlyph(status)} ${task.taskId} — ${task.taskName} · ${taskStatus(task)}`, status);
      if (task.checklist?.mode === "checkbox") {
        const firstPending = task.checklist.items.findIndex((item) => item.kind === "checkbox" && !item.checked);
        task.checklist.items.forEach((item, itemIndex) => {
          output.push(renderChecklistRow("      ", item, checklistStatus(item, itemIndex === firstPending), "", width, style));
        });
      } else if (task.planning) push("      进度：规划阶段（进度不可计算）", "muted");
      else if (task.checklist?.mode === "legacy") {
        push("      进度：进度不可计算（旧式清单，只读）", "muted");
        task.checklist.items.forEach((item) => push(`      · ${item.text}`));
      } else push("      进度：进度不可计算（无机器可读清单）", "muted");
      const link = rootOverview ? undefined : view.links.find((candidate) => candidate.repository === repository && candidate.repositoryTask === task);
      if (link) {
        push(`      关联：工作区 ${link.workspaceTaskId}（协调状态：${link.workspaceStatus}）`);
        if (!link.statusMatches) push(`      ! 协调状态 ${link.workspaceStatus} 与实现状态 ${task.statusRaw} 不同`, "warning");
      }
    });
    if (!rootOverview) {
      view.links.filter((link) => link.repository === repository && !link.repositoryTask && link.warning)
        .forEach((link) => push(`   ! 关联失败：工作区 ${link.workspaceTaskId} → ${link.ownerRepo}:${link.localTask}（${link.warning}）`, "warning"));
    }
    repository.warnings.forEach((warning) => push(`   ! ${warning.message}`, "warning"));
    push();
  });
  view.links.filter((link) => !link.repository).forEach((link) => push(`! 映射失败：工作区 ${link.workspaceTaskId} → ${link.ownerRepo}:${link.localTask}（${link.warning ?? "未匹配"}）`, "warning"));
  return output;
}
