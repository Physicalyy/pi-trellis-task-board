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
} from "../extensions/trellis-task-board/ui.ts";

function checkbox(completed: number, total: number): ChecklistParseResult {
  const items = Array.from({ length: total }, (_, i) => ({
    kind: "checkbox" as const,
    line: i + 2,
    markerStart: 10,
    markerEnd: 12,
    checked: i < completed,
    text: `item ${i}`,
    normalized: `item ${i}`,
  }));
  return { mode: "checkbox", items, completed, total, progressAvailable: true };
}

function repo(name: string, rel: string, tasks: RepositoryTaskSnapshot[], warnings: string[] = []): RepositorySnapshot {
  const counts = { total: tasks.length, completed: 0, inProgress: 0, planning: 0, review: 0, unknown: 0 };
  for (const t of tasks) {
    if (t.statusRaw === "completed") counts.completed++;
    else if (t.statusRaw === "in_progress") counts.inProgress++;
    else if (t.statusRaw === "planning") counts.planning++;
    else if (t.statusRaw === "review") counts.review++;
    else counts.unknown++;
  }
  return {
    packageName: name,
    relativePath: rel,
    root: rel,
    tasks,
    counts,
    warnings: warnings.map((message) => ({ code: "test", message })),
  };
}

function task(id: string, statusRaw: string, checklist: ChecklistParseResult | null): RepositoryTaskSnapshot {
  return {
    taskPath: `/repo/${id}`,
    taskId: id,
    taskName: `Title ${id}`,
    statusRaw,
    planning: statusRaw === "planning",
    checklist,
  };
}

function workspaceSnap(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    available: true,
    degraded: false,
    root: "/ws",
    taskPath: "/ws/.trellis/tasks/WS1",
    taskId: "WS1",
    taskName: "工作区协调任务",
    statusRaw: "in_progress",
    planning: false,
    checklist: checkbox(1, 4),
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregateBoardSnapshot> = {}): AggregateBoardSnapshot {
  const repos = [
    repo("a", "platform/repo-a", [
      task("08-01-msg-push", "in_progress", checkbox(3, 12)),
      task("08-02-done", "completed", null),
    ]),
    repo("b", "services/repo-b", [
      task("08-03-sso", "planning", null),
      task("08-04-weaver", "planning", null),
    ]),
  ];
  return {
    mode: "aggregate",
    root: "/ws",
    configState: { kind: "configured", packages: [], diagnostics: [] },
    workspace: workspaceSnap(),
    repositories: repos,
    links: [],
    warnings: [],
    fingerprint: "fp",
    ...overrides,
  };
}

test("aggregate widget shows title, workspace line and repo summaries", () => {
  const lines = renderAggregateWidgetLines(aggregate(), { width: 80 });
  assert.ok(lines[0].includes("trellis-task-board"));
  assert.ok(lines[0].includes("多根聚合"));
  assert.ok(lines.some((l) => l.includes("工作区") && l.includes("工作区协调任务")));
  assert.ok(lines.some((l) => l.includes("仓库") && l.includes("platform/repo-a") && l.includes("1/2 完成")));
  assert.ok(lines.some((l) => l.includes("services/repo-b") && l.includes("0/2 完成")));
});

test("aggregate widget is width-safe", () => {
  for (const width of [32, 48, 80]) {
    const lines = renderAggregateWidgetLines(aggregate(), { width });
    for (const l of lines) {
      assert.ok(visibleWidth(l) <= width, `width overflow at ${width}: ${JSON.stringify(l)}`);
    }
  }
});

test("aggregate widget never exceeds the hard row cap", () => {
  const repos = Array.from({ length: 12 }, (_, i) =>
    repo(`r${i}`, `platform/repo-${i}`, [task(`t${i}`, i % 2 === 0 ? "in_progress" : "planning", i % 2 === 0 ? checkbox(1, 2) : null)]),
  );
  const lines = renderAggregateWidgetLines(aggregate({ repositories: repos }), { width: 80 });
  assert.ok(lines.length <= MAX_AGGREGATE_WIDGET_ROWS, `rows=${lines.length}`);
  assert.ok(lines.some((l) => /\+N 个仓库折叠|\+\d+ 个仓库折叠/.test(l)), "fold marker present");
});

test("aggregate widget prioritizes in-progress repos and shows their progress", () => {
  const view = aggregate();
  const lines = renderAggregateWidgetLines(view, { width: 80 });
  // platform/repo-a (in_progress) appears before services/repo-b (planning only).
  const idxA = lines.findIndex((l) => l.includes("platform/repo-a"));
  const idxB = lines.findIndex((l) => l.includes("services/repo-b"));
  assert.ok(idxA >= 0 && idxB >= 0 && idxA < idxB);
  assert.ok(lines.some((l) => l.includes("进行中 3/12")), "checklist progress of in-progress task shown");
});

test("aggregate widget shows 进度不可计算 for in_progress without a machine-readable checklist", () => {
  // in_progress task with no checkbox checklist at all.
  const noChecklist = aggregate({
    repositories: [
      repo("a", "platform/repo-a", [task("08-01-msg-push", "in_progress", null), task("08-02-done", "completed", null)]),
    ],
  });
  const lines = renderAggregateWidgetLines(noChecklist, { width: 80 });
  assert.ok(lines.some((l) => l.includes("进度不可计算")), "widget must surface unavailable progress, not 0/N");
  assert.ok(!lines.some((l) => /进行中 0\/0|进行中 0\/N/.test(l)), "widget must never fabricate 0/N");

  // in_progress task whose only checklist is a read-only legacy numbered plan.
  const legacy: ChecklistParseResult = {
    mode: "legacy",
    items: [],
    completed: 0,
    total: 0,
    progressAvailable: false,
  };
  const legacyView = aggregate({
    repositories: [repo("a", "platform/repo-a", [task("08-01-legacy", "in_progress", legacy)])],
  });
  const legacyLines = renderAggregateWidgetLines(legacyView, { width: 80 });
  assert.ok(legacyLines.some((l) => l.includes("进度不可计算")), "legacy checklist is also 进度不可计算");
});

test("aggregate widget workspace empty state is explicit", () => {
  const lines = renderAggregateWidgetLines(
    aggregate({ workspace: { available: false, degraded: true, reason: "no-session", root: "/ws" } }),
    { width: 80 },
  );
  assert.ok(lines.some((l) => l.includes("无当前任务")));
  assert.ok(lines.some((l) => l.includes("无法确定当前 Trellis 会话")));
});

test("aggregate widget shows config diagnostics but still renders", () => {
  const lines = renderAggregateWidgetLines(
    aggregate({ warnings: [{ code: "config-yaml-parse", message: "config.yaml 无法解析" }], repositories: [] }),
    { width: 80 },
  );
  assert.ok(lines.some((l) => l.includes("config.yaml 无法解析")));
});

test("aggregate full list shows all non-archived tasks and status counts", () => {
  const lines = renderAggregateFullListLines(aggregate(), { width: 100 });
  const text = lines.join("\n");
  assert.ok(text.includes("多根聚合"));
  assert.ok(text.includes("platform/repo-a"));
  assert.ok(text.includes("completed 1 · in_progress 1"));
  assert.ok(text.includes("08-01-msg-push"));
  assert.ok(text.includes("08-02-done"));
  assert.ok(text.includes("08-03-sso"));
  assert.ok(text.includes("08-04-weaver"));
  assert.ok(text.includes("进度：3/12"));
  assert.ok(text.includes("进度不可计算"), "planning progress is not fabricated");
});

test("aggregate full list separates root writable scope from read-only subrepos", () => {
  const lines = renderAggregateFullListLines(aggregate(), { width: 100 });
  const text = lines.join("\n");
  assert.ok(text.includes("可写作用域（set_completed 唯一目标）"));
  // Root writable scope items carry 1-based mutation numbers.
  assert.match(text, /1\. \[x\] item 0/);
  assert.match(text, /2\. \[ \] item 1/);
  // Sub-repo checklist items never expose mutation numbers.
  const repoBlock = text.slice(text.indexOf("仓库：platform/repo-a"), text.indexOf("仓库：services/repo-b"));
  assert.ok(repoBlock.includes("item 0"));
  assert.ok(!/\n\s+\d+\. \[/.test(repoBlock), "subrepo items must not carry mutation numbers");
});

test("aggregate full list shows status differences and diagnostics", () => {
  const link: WorkspaceTaskLink = {
    workspaceTaskId: "WS1",
    workspaceTaskName: "工作区协调任务",
    workspaceStatus: "planning",
    ownerRepo: "platform/repo-a",
    localTask: "08-01-msg-push",
    repository: null,
    repositoryTask: null,
    statusMatches: false,
    warning: "owner-repo 未匹配任何已配置 package",
  };
  const lines = renderAggregateFullListLines(aggregate({ links: [link] }), { width: 100 });
  const text = lines.join("\n");
  assert.ok(text.includes("映射失败"));
  assert.ok(text.includes("未匹配"));
});

test("aggregate full list surfaces a partial mapping (owner-repo without local-task)", () => {
  const view = aggregate();
  const repo = view.repositories[0];
  const link: WorkspaceTaskLink = {
    workspaceTaskId: "WS1",
    workspaceTaskName: "工作区协调任务",
    workspaceStatus: "in_progress",
    ownerRepo: "platform/repo-a",
    localTask: "",
    repository: repo,
    repositoryTask: null,
    statusMatches: false,
    warning: "缺少 local-task（无法定位仓库内任务）",
  };
  const lines = renderAggregateFullListLines({ ...view, links: [link] }, { width: 100 });
  const text = lines.join("\n");
  assert.ok(text.includes("关联失败"), "partial mapping must be rendered as an explicit failure");
  assert.ok(text.includes("缺少 local-task"));
  assert.ok(text.includes("platform/repo-a:"), "the resolved repository is named in the diagnostic");
});

test("aggregate full list is width-safe at normal and narrow widths", () => {
  for (const width of [40, 80]) {
    const lines = renderAggregateFullListLines(aggregate(), { width });
    for (const l of lines) {
      assert.ok(visibleWidth(l) <= width, `width overflow at ${width}: ${JSON.stringify(l)}`);
    }
  }
});
