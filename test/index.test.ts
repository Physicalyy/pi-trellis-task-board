import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisTaskBoard from "../extensions/trellis-task-board/index.ts";
import { visibleWidth } from "../extensions/trellis-task-board/ui.ts";

function createAggregateFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ttb-agg-ext-"));
  const taskDir = join(root, ".trellis", "tasks", "task-ws");
  const sessionDir = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const repo = join(root, "platform", "repo-a");
  mkdirSync(join(repo, ".trellis", "tasks", "08-01-task"), { recursive: true });
  writeFileSync(
    join(repo, ".trellis", "tasks", "08-01-task", "task.json"),
    JSON.stringify({ id: "08-01-task", title: "Repo Task", status: "in_progress" }),
    "utf8",
  );
  writeFileSync(
    join(repo, ".trellis", "tasks", "08-01-task", "implement.md"),
    "## Checklist\n\n- [ ] a\n- [ ] b\n",
    "utf8",
  );
  writeFileSync(
    join(root, ".trellis", "config.yaml"),
    "packages:\n  repo-a:\n    path: platform/repo-a\n    git: true\n",
    "utf8",
  );
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({ id: "task-ws", title: "工作区任务", status: "in_progress" }),
    "utf8",
  );
  writeFileSync(join(taskDir, "implement.md"), "## Checklist\n\n- [ ] x\n- [ ] y\n", "utf8");
  writeFileSync(
    join(sessionDir, "pi_session-1.json"),
    JSON.stringify({ platform: "pi", current_task: ".trellis/tasks/task-ws" }),
    "utf8",
  );
  return root;
}

test("extension renders the aggregate widget and exposes aggregate list details", async () => {
  const handlers = new Map<string, Function[]>();
  const tools: unknown[] = [];
  let widget: unknown;
  const pi = {
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(_name: string, _command: unknown) {
      /* noop */
    },
  };
  trellisTaskBoard(pi as never);

  const root = createAggregateFixture();
  const ui = {
    setWidget(_key: string, value: unknown) {
      widget = value;
    },
    setStatus(_key: string, _value: string | undefined) {
      /* noop */
    },
  };
  const context = (cwd: string, trusted: boolean) => ({
    cwd,
    hasUI: true,
    mode: "tui",
    ui,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
  });

  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, context(root, true));
  }
  assert.equal(tools.length, 1);
  assert.equal(typeof widget, "function");

  try {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    };
    const component = (widget as unknown as Function)({}, theme);
    const lines = component.render(48) as string[];
    assert.ok(lines[0].includes("工作区"));
    assert.ok(lines.some((l) => l.includes("platform/repo-a")));
    for (const l of lines) {
      assert.ok(visibleWidth(l) <= 48, `width overflow: ${JSON.stringify(l)}`);
    }

    const tool = tools[0] as {
      execute: (
        id: unknown,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: ReturnType<typeof context>,
      ) => Promise<{ details: Record<string, unknown> }>;
    };
    const result = await tool.execute(null, { action: "list" }, null, null, context(root, true));
    assert.equal(result.details.mode, "aggregate");
    assert.equal(result.details.activeBinding, "bound");
    const repos = result.details.repositories as Array<{
      relativePath: string;
      readOnly: boolean;
      counts: { total: number };
    }>;
    assert.equal(repos.length, 1);
    assert.equal(repos[0].relativePath, "platform/repo-a");
    assert.equal(repos[0].counts.total, 1);
    assert.equal(repos[0].readOnly, true, "sub-repositories must be marked read-only");
    assert.equal(result.details.taskId, "task-ws");
    // The only writable scope is the root current task, never a repo path.
    const writable = result.details.writable as {
      taskId: string | null;
      taskPath: string | null;
      checklistAvailable: boolean;
      mutableItems: number;
    };
    assert.equal(writable.taskId, "task-ws");
    assert.equal(writable.taskPath, join(root, ".trellis", "tasks", "task-ws"));
    assert.equal(writable.checklistAvailable, true);
    assert.equal(writable.mutableItems, 2);

    // A second repo stays independent and read-only.
    const result2 = await tool.execute(null, { action: "list" }, null, null, context(root, true));
    const repos2 = result2.details.repositories as Array<{ readOnly: boolean }>;
    assert.equal(repos2[0].readOnly, true);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, context(root, true));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function createTrellisFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ttb-extension-"));
  const taskDir = join(root, ".trellis", "tasks", "task-1");
  const sessionDir = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({ id: "task-1", title: "宽度验证任务", status: "in_progress" }),
    "utf8",
  );
  writeFileSync(
    join(taskDir, "implement.md"),
    "## Checklist\n\n- [x] 已完成步骤\n- [ ] 当前步骤包含较长中文文本\n- [ ] 下一步骤\n",
    "utf8",
  );
  writeFileSync(
    join(sessionDir, "pi_session-1.json"),
    JSON.stringify({ platform: "pi", current_task: ".trellis/tasks/task-1" }),
    "utf8",
  );
  return root;
}

test("extension activates the model tool only in a trusted Trellis project and renders width-safe widget", async () => {
  const handlers = new Map<string, Function[]>();
  const tools: unknown[] = [];
  const commands = new Map<string, unknown>();
  let widget: unknown;
  let status: string | undefined;

  const pi = {
    on(name: string, handler: Function) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
  };

  trellisTaskBoard(pi as never);
  assert.equal(commands.has("trellis-tasks"), true);
  assert.equal(tools.length, 0, "global package must not expose its model tool before Trellis activation");

  const nonTrellis = mkdtempSync(join(tmpdir(), "ttb-non-trellis-"));
  const ui = {
    setWidget(_key: string, value: unknown) {
      widget = value;
    },
    setStatus(_key: string, value: string | undefined) {
      status = value;
    },
  };
  const context = (cwd: string, trusted: boolean) => ({
    cwd,
    hasUI: true,
    mode: "tui",
    ui,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
    },
  });

  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, context(nonTrellis, true));
  }
  assert.equal(tools.length, 0);
  assert.equal(widget, undefined);
  assert.equal(status, undefined);

  const root = createTrellisFixture();
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, context(root, true));
  }
  assert.equal(tools.length, 1);
  assert.equal(typeof widget, "function");

  try {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    };
    const component = (widget as unknown as Function)({}, theme);
    const lines = component.render(32) as string[];
    assert.ok(lines[0]?.includes("trellis-task-board"));
    assert.ok(lines.every((line) => visibleWidth(line) <= 32));
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, context(root, true));
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(nonTrellis, { recursive: true, force: true });
  }
  assert.equal(widget, undefined);
  assert.equal(status, undefined);
});
