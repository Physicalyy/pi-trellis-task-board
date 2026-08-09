import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import trellisTaskBoard from "../extensions/trellis-task-board/index.ts";
import { visibleWidth } from "../extensions/trellis-task-board/ui.ts";

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
