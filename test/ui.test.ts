import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardSnapshot } from "../extensions/trellis-task-board/task-state.ts";
import type { ChecklistParseResult } from "../extensions/trellis-task-board/checklist.ts";
import {
  formatStatus,
  renderFullListLines,
  renderWidgetLines,
  truncateToWidth,
  visibleWidth,
} from "../extensions/trellis-task-board/ui.ts";

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
  assert.equal(formatStatus(activeSnap()), "ACTIVE · Phase 2/3 · 1/5");
  assert.equal(formatStatus(activeSnap({ planning: true, statusRaw: "planning" })), "PLANNING · Phase 1 · awaiting activation");
  assert.equal(formatStatus(activeSnap({ statusRaw: "completed" })), "COMPLETED · Phase 3");
  assert.equal(formatStatus(activeSnap({ statusRaw: "review" })), "REVIEW");
  assert.equal(formatStatus(activeSnap({ statusRaw: "blocked-by-team" })), "BLOCKED BY TEAM");
  assert.equal(formatStatus({ available: false, degraded: false, reason: "not-trellis" }), "UNKNOWN STATUS");
});

test("renders bounded widget with the trellis-task-board title", () => {
  const lines = renderWidgetLines(activeSnap(), { width: 80, maxRows: 3 });
  assert.ok(lines[0].startsWith("trellis-task-board"));
  assert.ok(lines[0].includes("ACTIVE · Phase 2/3 · 1/5"));
  assert.equal(lines.length, 4); // header + 3 rows
  assert.ok(lines[3].includes("+2 more"));
  // rows show glyphs
  assert.ok(lines[1].includes("● initialize"), "first unchecked is current");
  assert.ok(lines[2].includes("✓ add middleware"));
});

test("planning widget shows gates, not execution progress", () => {
  const lines = renderWidgetLines(
    activeSnap({ planning: true, statusRaw: "planning", checklist: null }),
  );
  assert.ok(lines.some((l) => l.includes("Awaiting activation")));
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

test("degraded widget shows ! and reason, never a blocker status", () => {
  const lines = renderWidgetLines({ available: false, degraded: true, reason: "bad-json" });
  assert.ok(lines.some((l) => l.includes("!")));
  assert.ok(lines.some((l) => l.includes("bad-json")));
});

test("inactive widget mentions inactive", () => {
  const lines = renderWidgetLines({ available: false, degraded: false, reason: "not-trellis" });
  assert.ok(lines.some((l) => l.includes("Inactive")));
});

test("full list includes all items and is width-safe", () => {
  const lines = renderFullListLines(activeSnap(), { width: 40 });
  assert.ok(lines.length >= checkboxResult.items.length + 3);
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 40, `width overflow: ${JSON.stringify(l)}`);
  }
});