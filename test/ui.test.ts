import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardSnapshot } from "../extensions/trellis-task-board/task-state.ts";
import type { ChecklistItem, ChecklistParseResult } from "../extensions/trellis-task-board/checklist.ts";
import {
  formatReason,
  formatStatus,
  renderFullListLines,
  renderWidgetLines,
  selectCompactWindow,
  truncateToWidth,
  visibleWidth,
  type WidgetStyler,
} from "../extensions/trellis-task-board/ui.ts";

function items(count: number, checked: ReadonlySet<number>, cjk = false): ChecklistItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "checkbox" as const,
    line: index + 1,
    markerStart: 0,
    markerEnd: 0,
    checked: checked.has(index),
    text: cjk ? `中文任务 ${index}` : `item ${index}`,
    normalized: cjk ? `中文任务 ${index}` : `item ${index}`,
  }));
}

function checklist(source = items(5, new Set([0, 1]))): ChecklistParseResult {
  return {
    mode: "checkbox",
    items: source,
    completed: source.filter((item) => item.checked).length,
    total: source.length,
    progressAvailable: true,
  };
}

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    available: true,
    degraded: false,
    root: "/root",
    taskPath: "/root/.trellis/tasks/T1",
    taskId: "T1",
    taskName: "Task One",
    statusRaw: "in_progress",
    planning: false,
    checklist: checklist(),
    ...overrides,
  };
}

const ansiStyle = (): WidgetStyler => ({
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  strike: (text) => `\x1b[9m${text}\x1b[29m`,
  highlight: (text) => `\x1b[1m\x1b[36m${text}\x1b[39m\x1b[22m`,
  accent: (text) => `\x1b[36m${text}\x1b[39m`,
  text: (text) => `\x1b[37m${text}\x1b[39m`,
  muted: (text) => `\x1b[2m${text}\x1b[22m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  warning: (text) => `\x1b[33m${text}\x1b[39m`,
  error: (text) => `\x1b[31m${text}\x1b[39m`,
});

test("visible width and truncation are ANSI/CJK safe", () => {
  assert.equal(visibleWidth("a中文b"), 6);
  assert.equal(visibleWidth("\x1b[31m中文\x1b[0m"), 4);
  assert.equal(truncateToWidth("中文ab", 5), "中文a");
});

test("formatStatus maps only truthful lifecycle facts", () => {
  assert.equal(formatStatus(snapshot()), "进行中 · 阶段 2/3 · 2/5");
  assert.equal(formatStatus(snapshot({ planning: true, statusRaw: "planning", checklist: null })), "规划 · 阶段 1 · 等待激活");
  assert.equal(formatStatus(snapshot({ statusRaw: "completed" })), "已完成 · 阶段 3");
  assert.equal(formatStatus(snapshot({ statusRaw: "review" })), "评审中");
  assert.equal(formatStatus(snapshot({ statusRaw: "future-state" })), "FUTURE STATE");
});

test("compact window is one contiguous source slice and reports both sides", () => {
  const source = items(8, new Set([0, 1, 2, 3]));
  const window = selectCompactWindow(source, 3);
  assert.deepEqual(window.items.map((item) => item.text), ["item 3", "item 4", "item 5"]);
  assert.equal(window.currentIndex, 1);
  assert.equal(window.hiddenBefore, 3);
  assert.equal(window.hiddenAfter, 2);
  assert.equal(window.omitted, 5);
});

test("single widget uses only ✓/□ for checkboxes, source order, and exact remaining count", () => {
  const source = items(6, new Set([0, 1]));
  const lines = renderWidgetLines(snapshot({ checklist: checklist(source) }), { width: 80, maxRows: 3 });
  assert.deepEqual(lines.slice(1).map((line) => line.replace(/^[├└]─ /, "")), [
    "✓ item 1",
    "□ item 2",
    "□ item 3  … 还有 2 项",
  ]);
  assert.ok(!lines.join("\n").includes("→ 下一步"));
});

test("first and later pending glyphs are accent; only first pending body is accent+bold", () => {
  const calls: string[] = [];
  const style: WidgetStyler = {
    dim: (text) => text,
    strike: (text) => text,
    highlight: (text) => { calls.push(`highlight:${text}`); return `<H>${text}</H>`; },
    accent: (text) => { calls.push(`accent:${text}`); return `<A>${text}</A>`; },
    text: (text) => { calls.push(`text:${text}`); return `<T>${text}</T>`; },
    muted: (text) => text,
    bold: (text) => { calls.push(`bold:${text}`); return `<B>${text}</B>`; },
  };
  const lines = renderWidgetLines(snapshot({ checklist: checklist(items(3, new Set())) }), { width: 80, maxRows: 3, style });
  assert.equal(calls.filter((call) => call === "accent:□").length, 3);
  assert.ok(calls.some((call) => call === "accent:item 0"));
  assert.ok(calls.some((call) => call.includes("bold:<A>item 0</A>")));
  assert.ok(calls.some((call) => call === "text:item 1"));
  assert.ok(calls.some((call) => call === "text:item 2"));
  assert.ok(lines.join("\n").includes("<A>□</A>"));
});

test("completed glyph/body are dim and body struck; styled rows stay width safe", () => {
  for (const width of [32, 48, 80]) {
    const lines = renderWidgetLines(snapshot({ checklist: checklist(items(6, new Set([0, 1]), true)) }), {
      width,
      maxRows: 3,
      style: ansiStyle(),
    });
    assert.ok(lines.some((line) => line.includes("\x1b[9m")), "completed body struck");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("full list shares checkbox semantics and never invents next/current state", () => {
  const lines = renderFullListLines(snapshot(), { width: 40, style: ansiStyle() });
  const text = lines.join("\n");
  assert.ok(text.includes("✓") && text.includes("□"));
  assert.ok(!text.includes("→ 下一步"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("planning, legacy, degraded and inactive states remain explicit", () => {
  assert.ok(renderWidgetLines(snapshot({ planning: true, statusRaw: "planning", checklist: null })).some((line) => line.includes("等待激活")));
  const legacy: ChecklistParseResult = {
    mode: "legacy",
    items: [{ kind: "legacy", line: 1, markerStart: 0, markerEnd: 0, checked: false, text: "one", normalized: "one" }],
    completed: 0,
    total: 1,
    progressAvailable: false,
  };
  assert.ok(renderFullListLines(snapshot({ checklist: legacy })).some((line) => line.includes("进度不可计算")));
  assert.equal(formatReason("ambiguous-active-binding"), "当前会话在多个 Trellis 根中绑定任务");
  assert.ok(renderWidgetLines({ available: false, degraded: true, reason: "bad-task-json" }).some((line) => line.includes("task.json 无效")));
  assert.ok(renderWidgetLines({ available: false, degraded: false, reason: "not-trellis" }).some((line) => line.includes("未激活")));
});
