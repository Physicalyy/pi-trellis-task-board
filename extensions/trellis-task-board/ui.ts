/**
 * Pure, ANSI/CJK width-safe formatting for the bounded widget and the full
 * `/trellis-tasks` list. Node-only so it can be unit-tested standalone.
 */

import type { ChecklistItem } from "./checklist.ts";
import type { BoardSnapshot } from "./task-state.ts";

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero width space
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0x0300 && cp <= 0x036f) // combining diacritics
  );
}

/** Visible display width ignoring ANSI SGR escapes, counting CJK as 2. */
export function visibleWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  let w = 0;
  for (const ch of Array.from(clean)) {
    const cp = ch.codePointAt(0)!;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** Truncate a plain string so its visible width does not exceed `width`. */
export function truncateToWidth(s: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    if (isZeroWidth(cp)) {
      out += ch;
      continue;
    }
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > width) break;
    w += cw;
    out += ch;
  }
  return out;
}

/** Localize stable diagnostic codes while preserving unknown future values. */
export function formatReason(reason?: string): string {
  const messages: Record<string, string> = {
    untrusted: "项目不受信任",
    "not-trellis": "不是 Trellis 项目",
    "no-tasks-dir": "缺少 .trellis/tasks 目录",
    "no-session": "无法确定当前 Trellis 会话",
    "bad-task-ref": "当前任务引用无效",
    "missing-task-dir": "当前任务目录不存在",
    "task-outside-tasks": "当前任务超出安全目录",
    "missing-task-json": "缺少 task.json",
    "bad-task-json": "task.json 无效",
  };
  if (!reason) return "看板不可用";
  return messages[reason] ?? reason;
}

/** Truthful lifecycle-to-display mapping. Never invents approval/blocker/exact Phase 3. */
export function formatStatus(snapshot: BoardSnapshot): string {
  const raw = snapshot.statusRaw ?? "";
  if (snapshot.planning) return "规划 · 阶段 1 · 等待激活";
  if (raw === "in_progress") {
    const c = snapshot.checklist;
    if (c && c.mode === "checkbox" && c.total > 0) {
      return `进行中 · 阶段 2/3 · ${c.completed}/${c.total}`;
    }
    return "进行中 · 阶段 2/3";
  }
  if (raw === "completed") return "已完成 · 阶段 3";
  if (raw === "review") return "评审中";
  if (raw) return raw.replace(/[-_]+/g, " ").toUpperCase();
  return "未知状态";
}

export interface CompactWindow {
  /** the items actually shown in the window (a contiguous slice of the source) */
  items: ChecklistItem[];
  /** index into `items` of the next (first unchecked) checkbox, or -1 when none */
  currentIndex: number;
  /** number of source rows hidden by the compact window */
  omitted: number;
  /** number of genuinely pending checkbox rows hidden after the window */
  hiddenPending: number;
}

/**
 * Select a compact window of at most `maxRows` items centered on the first
 * unchecked checkbox (the visually current step). When the current step is
 * near the beginning the window expands forward; near the end it expands
 * backward. When every checkbox is completed the window shows the tail.
 */
export function selectCompactWindow(items: ChecklistItem[], maxRows: number): CompactWindow {
  if (items.length === 0) return { items: [], currentIndex: -1, omitted: 0, hiddenPending: 0 };
  const currentIndex = items.findIndex((i) => i.kind === "checkbox" && !i.checked);
  if (currentIndex === -1) {
    // All completed: show the most recent (tail) items.
    const start = Math.max(0, items.length - maxRows);
    return { items: items.slice(start), currentIndex: -1, omitted: start, hiddenPending: 0 };
  }
  const left = Math.floor((maxRows - 1) / 2);
  const start = Math.max(0, Math.min(currentIndex - left, items.length - maxRows));
  const end = Math.min(items.length, start + maxRows);
  const window = items.slice(start, end);
  return {
    items: window,
    currentIndex: currentIndex - start,
    omitted: items.length - window.length,
    hiddenPending: items.slice(end).filter((item) => item.kind === "checkbox" && !item.checked).length,
  };
}

type RowStatus = "completed" | "current" | "future" | "legacy" | "malformed";

function itemStatus(item: ChecklistItem, isCurrent: boolean): RowStatus {
  if (item.kind === "legacy") return "legacy";
  if (item.kind === "malformed") return "malformed";
  if (item.checked) return "completed";
  return isCurrent ? "current" : "future";
}

/** Status glyphs: completed ✓, next →, future □, legacy ·, malformed ?. */
function rowGlyph(status: RowStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "current":
      return "→";
    case "future":
      return "□";
    case "legacy":
      return "·";
    case "malformed":
      return "?";
  }
}

/** Claude-Code-like tree connector: ├─ for all but the last row, └─ for the last. */
function treePrefix(index: number, total: number): string {
  if (total <= 1) return "";
  return index === total - 1 ? "└─ " : "├─ ";
}

/**
 * Optional ANSI styling hooks supplied by the TUI layer (which has the theme).
 * Kept as callbacks so this module stays pure and unit-testable standalone.
 */
export interface WidgetStyler {
  dim(text: string): string;
  strike(text: string): string;
  highlight(text: string): string;
}

export interface WidgetRenderOptions {
  width?: number;
  maxRows?: number;
  style?: WidgetStyler;
}

function styleRow(status: RowStatus, text: string, style?: WidgetStyler): string {
  if (!style) return text;
  switch (status) {
    case "completed":
      return style.dim(style.strike(text));
    case "current":
      return style.highlight(text);
    default:
      // future / legacy / malformed stay plain
      return text;
  }
}

/**
 * Render the bounded above-editor widget lines. The visible title is always
 * `trellis-task-board`; the surface is one header plus up to `maxRows` rows
 * showing a compact window centered on the current execution step.
 */
export function renderWidgetLines(snapshot: BoardSnapshot, opts?: WidgetRenderOptions): string[] {
  const width = opts?.width ?? 80;
  const maxRows = opts?.maxRows ?? 3;
  const style = opts?.style;
  const lines: string[] = [];

  const title = "trellis-task-board";
  const status = snapshot.degraded ? "!" : formatStatus(snapshot);
  const headerLine = title + " ".repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(status))) + status;
  lines.push(truncateToWidth(headerLine, width).replace(/\s+$/, ""));

  if (snapshot.degraded) {
    lines.push(`! ${formatReason(snapshot.reason)}`);
    if (snapshot.taskName) lines.push(`· ${snapshot.taskName}`);
    return lines;
  }
  if (!snapshot.available) {
    lines.push("· 未激活（无受信任的 Trellis 任务）");
    return lines;
  }

  if (snapshot.planning) {
    lines.push("· PRD / Design / Plan / 上下文材料");
    lines.push("· 等待任务激活（状态：planning）");
    return lines;
  }

  const c = snapshot.checklist;
  if (!c || c.items.length === 0) {
    lines.push("· 无机器可读的检查清单");
    return lines;
  }

  // Legacy numbered plans stay read-only and show the leading steps in order;
  // real checkbox checklists use the execution-centered compact window.
  const useTree = c.mode !== "legacy";
  let window: ChecklistItem[];
  let currentIndex: number;
  let hiddenPending: number;
  if (c.mode === "legacy") {
    window = c.items.slice(0, maxRows);
    currentIndex = -1;
    hiddenPending = 0;
  } else {
    const win = selectCompactWindow(c.items, maxRows);
    window = win.items;
    currentIndex = win.currentIndex;
    hiddenPending = win.hiddenPending;
  }

  for (let i = 0; i < window.length; i++) {
    const item = window[i];
    const st = itemStatus(item, i === currentIndex);
    const glyph = rowGlyph(st);
    const prefix = useTree ? treePrefix(i, window.length) : "";
    const text = item.normalized || "(empty)";
    const label = st === "current" ? `下一步：${text}` : text;
    let plain = `${prefix}${glyph} ${label}`;
    if (i === window.length - 1 && hiddenPending > 0) {
      plain += `  后续 ${hiddenPending} 项`;
    }
    plain = truncateToWidth(plain, width);
    lines.push(styleRow(st, plain, style));
  }

  return lines;
}

/** Full, scrollable-safe list used by `/trellis-tasks` (and its non-TUI fallback). */
export function renderFullListLines(snapshot: BoardSnapshot, opts?: { width?: number }): string[] {
  const width = opts?.width ?? 100;
  const out: string[] = [];
  const status = snapshot.degraded ? "!" : formatStatus(snapshot);
  const title = `trellis-task-board  ${snapshot.available ? "·" : ""} ${status}`;
  out.push(truncateToWidth(title, width));

  if (snapshot.degraded) {
    out.push(`  ! ${formatReason(snapshot.reason)}`);
    return out;
  }
  if (!snapshot.available) {
    out.push(truncateToWidth("  未激活：无受信任的 Trellis 任务。", width));
    return out;
  }

  const name = snapshot.taskName || snapshot.taskId || "(未命名任务)";
  const idLine = snapshot.taskId ? `${snapshot.taskId} — ${name}` : name;
  out.push(truncateToWidth(`  任务：${idLine}`, width));
  out.push(truncateToWidth(`  状态：${snapshot.statusRaw ?? "unknown"}`, width));
  out.push("");

  const c = snapshot.checklist;
  if (snapshot.planning) {
    out.push("  阶段 1 · 规划");
    out.push("  门禁：PRD / Design / Plan / 上下文材料");
    out.push("  等待任务激活（状态：planning）");
    out.push("");
    out.push("  规划阶段不显示执行进度。");
    return out;
  }
  if (!c || c.items.length === 0) {
    out.push("  无机器可读的执行检查清单。");
    out.push("  进度不可计算。");
    return out;
  }

  if (c.mode === "legacy") {
    out.push("  旧式编号计划 — 进度不可计算（只读）。");
    out.push("");
    c.items.forEach((item, i) => {
      out.push(truncateToWidth(`  ${i + 1}. ${item.text}`, width));
    });
    return out;
  }

  const firstUnchecked = c.items.findIndex((i) => i.kind === "checkbox" && !i.checked);
  c.items.forEach((item, i) => {
    const glyph = rowGlyph(itemStatus(item, i === firstUnchecked));
    out.push(truncateToWidth(`  ${glyph} ${item.text}`, width));
  });
  return out;
}