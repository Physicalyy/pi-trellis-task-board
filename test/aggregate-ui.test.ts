import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardSnapshot } from "../extensions/trellis-task-board/task-state.ts";
import type { ChecklistParseResult } from "../extensions/trellis-task-board/checklist.ts";
import type {
  AggregateBoardSnapshot,
  RepositorySnapshot,
  RepositoryTaskSnapshot,
  WorkspaceTaskLink,
} from "../extensions/trellis-task-board/aggregate-state.ts";
import {
  MAX_AGGREGATE_WIDGET_ROWS,
  renderAggregateFullListLines,
  renderAggregateWidgetLines,
  visibleWidth,
  type WidgetStyler,
} from "../extensions/trellis-task-board/ui.ts";

function checkbox(completed: number, total: number, cjk = false): ChecklistParseResult {
  const items = Array.from({ length: total }, (_, index) => ({
    kind: "checkbox" as const,
    line: index + 1,
    markerStart: 0,
    markerEnd: 0,
    checked: index < completed,
    text: cjk ? `中文步骤 ${index}` : `item ${index}`,
    normalized: cjk ? `中文步骤 ${index}` : `item ${index}`,
  }));
  return { mode: "checkbox", items, completed, total, progressAvailable: true };
}

function task(id: string, statusRaw: string, checklist: ChecklistParseResult | null): RepositoryTaskSnapshot {
  return { taskPath: `/repo/${id}`, taskId: id, taskName: `Title ${id}`, statusRaw, planning: statusRaw === "planning", checklist };
}

function repo(name: string, relativePath: string, tasks: RepositoryTaskSnapshot[]): RepositorySnapshot {
  const counts = { total: tasks.length, completed: 0, inProgress: 0, planning: 0, review: 0, unknown: 0 };
  tasks.forEach((entry) => {
    if (entry.statusRaw === "completed") counts.completed++;
    else if (entry.statusRaw === "in_progress") counts.inProgress++;
    else if (entry.statusRaw === "planning") counts.planning++;
    else if (entry.statusRaw === "review") counts.review++;
    else counts.unknown++;
  });
  return { packageName: name, relativePath, root: `/${relativePath}`, source: "discovered", tasks, counts, warnings: [] };
}

function boundSnapshot(): BoardSnapshot {
  return {
    available: true,
    degraded: false,
    root: "/ws/platform/repo-a",
    taskPath: "/ws/platform/repo-a/.trellis/tasks/A",
    taskId: "A",
    taskName: "当前子仓库任务",
    statusRaw: "in_progress",
    planning: false,
    checklist: checkbox(2, 6),
  };
}

function aggregate(overrides: Partial<AggregateBoardSnapshot> = {}): AggregateBoardSnapshot {
  const repositories = [
    repo("a", "platform/repo-a", [task("A", "in_progress", checkbox(2, 6)), task("DONE", "completed", checkbox(2, 2))]),
    repo("b", "services/repo-b", [task("PLAN", "planning", null)]),
  ];
  const active = boundSnapshot();
  return {
    mode: "aggregate",
    root: "/ws",
    workspaceRoot: "/ws",
    cwdRoot: "/ws/platform/repo-a",
    configState: { kind: "unconfigured" },
    workspace: { available: false, degraded: true, reason: "no-session", root: "/ws" },
    repositories,
    links: [],
    activeBinding: { kind: "bound", root: active.root!, repository: repositories[0], snapshot: active },
    warnings: [],
    fingerprint: "fp",
    ...overrides,
  };
}

const style: WidgetStyler = {
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  strike: (text) => `\x1b[9m${text}\x1b[29m`,
  highlight: (text) => `\x1b[1m\x1b[36m${text}\x1b[39m\x1b[22m`,
  accent: (text) => `\x1b[36m${text}\x1b[39m`,
  text: (text) => `\x1b[37m${text}\x1b[39m`,
  muted: (text) => `\x1b[2m${text}\x1b[22m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  warning: (text) => `\x1b[33m${text}\x1b[39m`,
  error: (text) => `\x1b[31m${text}\x1b[39m`,
};

test("aggregate widget shows overall lifecycle, unique binding and its checklist", () => {
  const lines = renderAggregateWidgetLines(aggregate(), { width: 80 });
  const text = lines.join("\n");
  assert.ok(text.includes("trellis-task-board"));
  assert.ok(text.includes("工作区 1/3 完成"));
  assert.ok(text.includes("当前执行") && text.includes("当前子仓库任务"));
  assert.ok(text.includes("✓ item 1"));
  assert.ok(text.includes("□ item 2"));
  assert.ok(!text.includes("→ 下一步"));
});

test("unbound aggregate remains visible and explicit", () => {
  const view = aggregate({ activeBinding: { kind: "unbound" } });
  const lines = renderAggregateWidgetLines(view, { width: 80 });
  assert.ok(lines.some((line) => line.includes("当前会话未绑定执行任务")));
  assert.ok(lines.some((line) => line.includes("工作区 1/3 完成")));
});

test("ambiguous aggregate warns without selecting a task", () => {
  const view = aggregate({ activeBinding: { kind: "ambiguous", bindings: [
    { root: "/ws", taskId: "W", taskName: "W" },
    { root: "/ws/r", taskId: "R", taskName: "R" },
  ] } });
  const lines = renderAggregateWidgetLines(view, { width: 80, style });
  assert.ok(lines.some((line) => line.includes("2 个根") && line.includes("拒绝猜测")));
  assert.ok(!lines.some((line) => line.includes("当前子仓库任务")));
});

test("aggregate widget has hard cap, fold command and width safety at 32/48/80", () => {
  const repositories = Array.from({ length: 12 }, (_, index) => repo(`r${index}`, `platform/很长的仓库-${index}`, [task(`T${index}`, "planning", null)]));
  for (const width of [32, 48, 80]) {
    const lines = renderAggregateWidgetLines(aggregate({ repositories }), { width, style });
    assert.ok(lines.length <= MAX_AGGREGATE_WIDGET_ROWS);
    assert.ok(lines.some((line) => line.includes("/trellis-tasks")));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("aggregate checklist gets the available third row without reserving a nonexistent repository row", () => {
  const lines = renderAggregateWidgetLines(aggregate({ repositories: [] }), { width: 80 });
  assert.equal(lines.length, 5);
  assert.ok(lines.some((line) => line.includes("item 3") && line.includes("… 还有 2 项")));
});

test("aggregate widget styles checkbox segments accessibly", () => {
  const lines = renderAggregateWidgetLines(aggregate(), { width: 80, style });
  const text = lines.join("\n");
  assert.ok(text.includes("\x1b[9m"), "completed body uses strike");
  assert.ok(text.includes("\x1b[36m□"), "pending glyph uses accent");
  assert.ok(!/[⏺☒☐]/u.test(text));
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("aggregate full list keeps repository checklists read-only and ✓/□ only", () => {
  const lines = renderAggregateFullListLines(aggregate(), { width: 120, style });
  const text = lines.join("\n");
  assert.ok(text.includes("当前执行：platform/repo-a"));
  assert.ok(text.includes("可写作用域（set_completed 唯一目标）"));
  assert.ok(text.includes("只读仓库"));
  assert.ok(text.includes("✓") && text.includes("□"));
  assert.ok(!text.includes("→ 下一步"));
  const repoBlock = text.slice(text.indexOf("├─ platform/repo-a"));
  assert.ok(!/\n\s+\d+\. \[[ x]\]/.test(repoBlock), "repository checklist rows have no mutation number");
});

test("full list shows unbound/ambiguous writable scope and mapping diagnostics", () => {
  const link: WorkspaceTaskLink = {
    workspaceTaskId: "WS",
    workspaceTaskName: "Coord",
    workspaceStatus: "in_progress",
    ownerRepo: "missing",
    localTask: "T",
    repository: null,
    repositoryTask: null,
    statusMatches: false,
    warning: "未匹配",
  };
  const unbound = renderAggregateFullListLines(aggregate({ activeBinding: { kind: "unbound" }, links: [link] }), { width: 100 }).join("\n");
  assert.ok(unbound.includes("当前会话未绑定执行任务"));
  assert.ok(unbound.includes("可写作用域：无"));
  assert.ok(unbound.includes("映射失败"));

  const ambiguous = renderAggregateFullListLines(aggregate({ activeBinding: { kind: "ambiguous", bindings: [
    { root: "/a", taskId: "A", taskName: "A" }, { root: "/b", taskId: "B", taskName: "B" },
  ] } }), { width: 100 }).join("\n");
  assert.ok(ambiguous.includes("写入已禁用"));
});

test("aggregate full list is CJK/ANSI width safe", () => {
  const active = boundSnapshot();
  active.checklist = checkbox(1, 5, true);
  const view = aggregate({ activeBinding: { kind: "bound", root: active.root!, repository: null, snapshot: active } });
  for (const width of [32, 48, 80]) {
    const lines = renderAggregateFullListLines(view, { width, style });
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});
