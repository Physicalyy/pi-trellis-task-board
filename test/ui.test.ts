import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardSnapshot } from "../extensions/trellis-task-board/task-state.ts";
import type { ChecklistParseResult } from "../extensions/trellis-task-board/checklist.ts";
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
import type { ChecklistItem } from "../extensions/trellis-task-board/checklist.ts";

const checkboxResult: ChecklistParseResult = {
  mode: "checkbox",
  items: [
    {
      kind: "checkbox",
      line: 2,
      markerStart: 10,
      markerEnd: 12,
      checked: false,
      text: "Initialize",
      normalized: "initialize",
    },
    {
      kind: "checkbox",
      line: 3,
      markerStart: 10,
      markerEnd: 12,
      checked: true,
      text: "Add middleware",
      normalized: "add middleware",
    },
    {
      kind: "checkbox",
      line: 4,
      markerStart: 10,
      markerEnd: 12,
      checked: false,
      text: "Wire polling",
      normalized: "wire polling",
    },
    {
      kind: "checkbox",
      line: 5,
      markerStart: 10,
      markerEnd: 12,
      checked: false,
      text: "Fourth",
      normalized: "fourth",
    },
    {
      kind: "checkbox",
      line: 6,
      markerStart: 10,
      markerEnd: 12,
      checked: false,
      text: "Fifth",
      normalized: "fifth",
    },
  ],
  completed: 1,
  total: 5,
  progressAvailable: true,
};

function activeSnap(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    available: true,
    degraded: false,
    root: "/repo",
    taskId: "T1",
    taskName: "Task One",
    statusRaw: "in_progress",
    planning: false,
    checklist: checkboxResult,
    ...overrides,
  };
}

test("visibleWidth counts CJK as 2 and ignores ANSI", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("中文"), 4);
  assert.equal(visibleWidth("a中b"), 4);
  const ansi = "\x1b[31mred\x1b[0m";
  assert.equal(visibleWidth(ansi), 3);
});

test("truncateToWidth respects CJK width", () => {
  assert.equal(truncateToWidth("abcdef", 3), "abc");
  assert.equal(truncateToWidth("中文ab", 4), "中文");
  assert.equal(truncateToWidth("中文ab", 5), "中文a");
});

test("formatStatus truthfully maps states", () => {
  assert.equal(formatStatus(activeSnap()), "进行中 · 阶段 2/3 · 1/5");
  assert.equal(formatStatus(activeSnap({ planning: true, statusRaw: "planning" })), "规划 · 阶段 1 · 等待激活");
  assert.equal(formatStatus(activeSnap({ statusRaw: "completed" })), "已完成 · 阶段 3");
  assert.equal(formatStatus(activeSnap({ statusRaw: "review" })), "评审中");
  assert.equal(formatStatus(activeSnap({ statusRaw: "blocked-by-team" })), "BLOCKED BY TEAM");
  assert.equal(formatStatus({ available: false, degraded: false, reason: "not-trellis" }), "未知状态");
});

function makeItems(count: number, checkedSet: ReadonlySet<number>): ChecklistItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "checkbox" as const,
    line: i + 2,
    markerStart: 10,
    markerEnd: 12,
    checked: checkedSet.has(i),
    text: `item ${i}`,
    normalized: `item ${i}`,
  }));
}

function checkSnap(items: ChecklistItem[]): BoardSnapshot {
  return activeSnap({
    checklist: {
      mode: "checkbox",
      items,
      completed: items.filter((i) => i.checked).length,
      total: items.length,
      progressAvailable: true,
    },
  });
}

const plainStyler = (): WidgetStyler => ({
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  strike: (t) => `\x1b[9m${t}\x1b[29m`,
  highlight: (t) => `\x1b[1m${t}\x1b[22m`,
});

test("renders bounded widget with the trellis-task-board title and centered window", () => {
  const lines = renderWidgetLines(activeSnap(), { width: 80, maxRows: 3 });
  assert.ok(lines[0].startsWith("trellis-task-board"));
  assert.ok(lines[0].includes("进行中 · 阶段 2/3 · 1/5"));
  assert.equal(lines.length, 4); // header + 3 rows
  assert.ok(lines[1].includes("→ 下一步：initialize"), "first unchecked item is labeled as next, not executing");
  assert.ok(lines[2].includes("✓ add middleware"), "completed context is preserved");
  assert.ok(lines[3].includes("后续 2 项"), "only genuinely pending hidden rows are counted");
});

test("compact window: current at the beginning expands forward", () => {
  const win = selectCompactWindow(makeItems(5, new Set()), 3);
  assert.equal(win.currentIndex, 0);
  assert.equal(win.omitted, 2);
  assert.equal(win.hiddenPending, 2);
  assert.deepEqual(win.items.map((i) => i.normalized), ["item 0", "item 1", "item 2"]);
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set())), { width: 80, maxRows: 3 });
  assert.ok(lines[1].includes("→ 下一步：item 0"));
  assert.ok(lines[2].includes("□ item 1"));
  assert.ok(lines[3].includes("□ item 2  后续 2 项"));
});

test("compact window: current in the middle shows previous + current + next", () => {
  const win = selectCompactWindow(makeItems(5, new Set([0, 1])), 3);
  assert.equal(win.currentIndex, 1);
  assert.equal(win.omitted, 2);
  assert.equal(win.hiddenPending, 1);
  assert.deepEqual(win.items.map((i) => i.normalized), ["item 1", "item 2", "item 3"]);
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set([0, 1]))), { width: 80, maxRows: 3 });
  assert.ok(lines[1].includes("✓ item 1"), "previous completed");
  assert.ok(lines[2].includes("→ 下一步：item 2"), "first unchecked is explicitly the next step");
  assert.ok(lines[3].includes("□ item 3  后续 1 项"), "only pending rows after the window are counted");
});

test("compact window: current at the end expands backward and reports hidden items", () => {
  const win = selectCompactWindow(makeItems(5, new Set([0, 1, 2, 3])), 3);
  assert.equal(win.currentIndex, 2);
  assert.equal(win.omitted, 2);
  assert.equal(win.hiddenPending, 0);
  assert.deepEqual(win.items.map((i) => i.normalized), ["item 2", "item 3", "item 4"]);
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set([0, 1, 2, 3]))), { width: 80, maxRows: 3 });
  assert.ok(lines[1].includes("✓ item 2"));
  assert.ok(lines[2].includes("✓ item 3"));
  assert.ok(lines[3].includes("→ 下一步：item 4"));
  assert.ok(!lines[3].includes("后续"), "hidden completed rows are not reported as pending work");
});

test("compact window: all completed shows the tail", () => {
  const win = selectCompactWindow(makeItems(5, new Set([0, 1, 2, 3, 4])), 3);
  assert.equal(win.currentIndex, -1);
  assert.equal(win.omitted, 2);
  assert.equal(win.hiddenPending, 0);
  assert.deepEqual(win.items.map((i) => i.normalized), ["item 2", "item 3", "item 4"]);
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set([0, 1, 2, 3, 4]))), { width: 80, maxRows: 3 });
  assert.ok(lines.slice(1).every((l) => l.includes("✓")));
  assert.ok(!lines.some((l) => l.includes("后续")));
});

test("widget rows are tree-connected and width-safe", () => {
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set([0, 1]))), { width: 30 });
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith("├─ "));
  assert.ok(lines[2].startsWith("├─ "));
  assert.ok(lines[3].startsWith("└─ "));
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 30, `width overflow: ${JSON.stringify(l)}`);
  }
});

test("widget applies theme styling: completed dim+strike, current highlighted, future plain", () => {
  const style = plainStyler();
  const lines = renderWidgetLines(checkSnap(makeItems(5, new Set([0, 1]))), {
    width: 80,
    maxRows: 3,
    style,
  });
  assert.ok(lines[1].includes("\x1b[2m") && lines[1].includes("✓ item 1"), "completed dimmed");
  assert.ok(lines[1].includes("\x1b[9m"), "completed struck through");
  assert.ok(lines[2].includes("\x1b[1m") && lines[2].includes("→ 下一步：item 2"), "next step highlighted");
  assert.ok(lines[3].includes("□ item 3"), "future stays plain");
  assert.ok(!lines[3].includes("\x1b[2m"), "future not dimmed");
  // ANSI styling must not inflate measured width.
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 80, `styled width overflow: ${JSON.stringify(l)}`);
  }
});

test("planning widget shows gates, not execution progress", () => {
  const lines = renderWidgetLines(
    activeSnap({ planning: true, statusRaw: "planning", checklist: null }),
  );
  assert.ok(lines.some((l) => l.includes("等待激活")));
  assert.ok(!lines.some((l) => l.includes("/5")));
});

test("legacy widget does not claim 0/N", () => {
  const legacy: ChecklistParseResult = {
    mode: "legacy",
    items: [
      { kind: "legacy", line: 1, markerStart: 0, markerEnd: 0, checked: false, text: "one", normalized: "one" },
      { kind: "legacy", line: 2, markerStart: 0, markerEnd: 0, checked: false, text: "two", normalized: "two" },
    ],
    completed: 0,
    total: 2,
    progressAvailable: false,
  };
  const lines = renderWidgetLines(activeSnap({ checklist: legacy }));
  assert.ok(!lines.some((l) => l.includes("0/2")));
  assert.ok(lines.some((l) => l.includes("· one")));
  assert.ok(!lines.some((l) => l.includes("/2")));
});

test("degraded widget localizes known reasons and never invents a blocker status", () => {
  const lines = renderWidgetLines({ available: false, degraded: true, reason: "bad-task-json" });
  assert.ok(lines.some((l) => l.includes("!")));
  assert.ok(lines.some((l) => l.includes("task.json 无效")));
  assert.equal(formatReason("future-code"), "future-code");
});

test("inactive widget mentions inactive", () => {
  const lines = renderWidgetLines({ available: false, degraded: false, reason: "not-trellis" });
  assert.ok(lines.some((l) => l.includes("未激活")));
});

test("full list includes all items and is width-safe", () => {
  const lines = renderFullListLines(activeSnap(), { width: 40 });
  assert.ok(lines.length >= checkboxResult.items.length + 3);
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 40, `width overflow: ${JSON.stringify(l)}`);
  }
  assert.ok(lines.some((l) => l.includes("任务：T1 — Task One")));
  assert.ok(lines.some((l) => l.includes("状态：in_progress")));
});

test("full list planning shows localized gates and no execution progress", () => {
  const lines = renderFullListLines(
    activeSnap({ planning: true, statusRaw: "planning", checklist: null }),
  );
  assert.ok(lines.some((l) => l.includes("阶段 1 · 规划")));
  assert.ok(lines.some((l) => l.includes("门禁：PRD / Design / Plan / 上下文材料")));
  assert.ok(lines.some((l) => l.includes("等待任务激活")));
  assert.ok(lines.some((l) => l.includes("规划阶段不显示执行进度。")));
  assert.ok(!lines.some((l) => l.includes("1/5")));
});

test("full list legacy shows progress unavailable and read-only", () => {
  const legacy: ChecklistParseResult = {
    mode: "legacy",
    items: [
      { kind: "legacy", line: 1, markerStart: 0, markerEnd: 0, checked: false, text: "one", normalized: "one" },
      { kind: "legacy", line: 2, markerStart: 0, markerEnd: 0, checked: false, text: "two", normalized: "two" },
    ],
    completed: 0,
    total: 2,
    progressAvailable: false,
  };
  const lines = renderFullListLines(activeSnap({ checklist: legacy }));
  assert.ok(lines.some((l) => l.includes("旧式编号计划")));
  assert.ok(lines.some((l) => l.includes("进度不可计算")));
  assert.ok(lines.some((l) => l.includes("只读")));
});

test("full list inactive is localized and CJK-width-safe", () => {
  const lines = renderFullListLines({ available: false, degraded: false, reason: "not-trellis" }, { width: 30 });
  assert.ok(lines.some((l) => l.includes("未激活")));
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 30, `width overflow: ${JSON.stringify(l)}`);
  }
});

test("full list degraded uses localized default reason", () => {
  const lines = renderFullListLines({ available: false, degraded: true, reason: "bad-task-json" });
  assert.ok(lines.some((l) => l.includes("task.json 无效")));
  const noReason = renderFullListLines({ available: false, degraded: true });
  assert.ok(noReason.some((l) => l.includes("看板不可用")));
});