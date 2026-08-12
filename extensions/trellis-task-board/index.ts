/**
 * Pi Package: Trellis Task Board
 *
 * Renders a persistent `trellis-task-board` widget above the editor, synced
 * with the current project's Trellis task files (runtime session pointer,
 * `task.json`, and `implement.md`). Activates only for trusted Trellis
 * projects and degrades quietly everywhere else.
 *
 * The widget and `/trellis-tasks` are diagnostic/read-only. The only write is
 * `trellis_task_board.set_completed`, which toggles a single checkbox marker in
 * an existing canonical `implement.md` inside `.trellis/tasks/`.
 *
 * No Trellis-managed file (scripts, workflow, project `.pi/settings.json`,
 * official agents/prompts/skills) is ever modified by this package.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { formatReason, formatStatus, renderFullListLines, renderWidgetLines, truncateToWidth, type WidgetStyler } from "./ui.ts";
import { type BoardSnapshot, type SessionIdentity } from "./task-state.ts";
import { setCompleted } from "./mutation.ts";
import { isAggregate, loadBoard, loadWritableSnapshot, viewMode, type AggregateBoardSnapshot, type BoardView } from "./aggregate-state.ts";

const WIDGET_KEY = "trellis-task-board";
const POLL_MS = 10_000;

const BOARD_TOOL_PARAMS = Type.Object({
  action: StringEnum(["list", "set_completed"] as const, { description: "Board action" }),
  item: Type.Optional(Type.Integer({ minimum: 1, description: "1-based item number (set_completed)" })),
  expectedText: Type.Optional(Type.String({ description: "Exact checkbox text of the item (set_completed)" })),
  completed: Type.Optional(Type.Boolean({ description: "Desired checked state (set_completed)" })),
});

function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
  let sessionId: string | null = null;
  try {
    const sid = ctx.sessionManager?.getSessionId?.();
    if (typeof sid === "string" && sid) sessionId = sid;
  } catch {
    /* ignore */
  }
  if (!sessionId) {
    const env = process.env.PI_SESSION_ID || process.env.PI_SESSIONID;
    if (env) sessionId = env;
  }
  let transcriptPath: string | null = null;
  try {
    const tf = ctx.sessionManager?.getSessionFile?.();
    if (typeof tf === "string" && tf) transcriptPath = tf;
  } catch {
    /* ignore */
  }
  return { sessionId, transcriptPath };
}

export default function trellisTaskBoard(pi: ExtensionAPI): void {
  let current: BoardView | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let generation = 0;

  function stopPoll(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function load(ctx: ExtensionContext): BoardView {
    return loadBoard(ctx.cwd, sessionIdentity(ctx), ctx.isProjectTrusted());
  }

  function setBoardWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render(width: number): string[] {
        // Renderers budget plain semantic segments before theme styling.
        const style: WidgetStyler = {
          dim: (t) => theme.fg("dim", t),
          strike: (t) => theme.strikethrough(t),
          highlight: (t) => theme.bold(theme.fg("accent", t)),
          accent: (t) => theme.fg("accent", t),
          text: (t) => theme.fg("text", t),
          muted: (t) => theme.fg("muted", t),
          bold: (t) => theme.bold(t),
          warning: (t) => theme.fg("warning", t),
          error: (t) => theme.fg("error", t),
        };
        return current ? renderWidgetLines(current, { width, style }) : [];
      },
      invalidate() {
        /* snapshot changes replace the widget factory */
      },
    }));
  }

  function render(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!current) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      return;
    }
    if (isAggregate(current)) {
      // Multi-root aggregate mode: the workspace block stays visible even
      // when the workspace task itself is degraded / has no session, as long
      // as the packages declaration is explicit. Read-only, never deactivates
      // the aggregate just because the workspace has no current task.
      setBoardWidget(ctx);
      ctx.ui.setStatus(WIDGET_KEY, aggregateSummary(current));
      return;
    }
    if (current.degraded) {
      setBoardWidget(ctx);
      ctx.ui.setStatus(WIDGET_KEY, `! ${formatReason(current.reason)}`);
      return;
    }
    if (!current.available) {
      // Non-Trellis or untrusted: quiet deactivation.
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      return;
    }
    setBoardWidget(ctx);
    const status = formatStatus(current);
    ctx.ui.setStatus(
      WIDGET_KEY,
      `${current.taskName || current.taskId || ""} · ${status}`,
    );
  }

  function snapshotKey(snapshot: BoardView): string {
    if (isAggregate(snapshot)) {
      return `agg:${snapshot.fingerprint ?? ""}`;
    }
    return snapshot.fingerprint ?? JSON.stringify({
      available: snapshot.available,
      degraded: snapshot.degraded,
      reason: snapshot.reason ?? null,
      root: snapshot.root ?? null,
      contextKey: snapshot.contextKey ?? null,
      taskPath: snapshot.taskPath ?? null,
      statusRaw: snapshot.statusRaw ?? null,
    });
  }

  function refresh(ctx: ExtensionContext): BoardView {
    const snap = load(ctx);
    if (current && snapshotKey(snap) === snapshotKey(current)) return current;
    current = snap;
    render(ctx);
    return current;
  }

  function activate(ctx: ExtensionContext): void {
    generation++;
    stopPoll();
    current = load(ctx);
    if (current.root && ctx.isProjectTrusted()) registerBoardTool();
    render(ctx);
    if (current.root) startPoll(ctx);
  }

  function aggregateSummary(view: AggregateBoardSnapshot): string {
    const binding = view.activeBinding?.kind ?? (view.workspace.available ? "bound" : "unbound");
    const bindingText = binding === "bound" ? "已绑定" : binding === "ambiguous" ? "绑定歧义" : "未绑定";
    return `工作区聚合 · ${view.repositories.length} 仓库 · ${bindingText}`;
  }

  /**
   * The only writable scope is the task uniquely bound to the current Pi
   * session across all discovered roots. Repository overview rows remain
   * read-only; callers cannot provide a root, task, or filesystem path.
   */
  function writableScope(view: BoardView): {
    taskId: string | null;
    taskPath: string | null;
    checklistAvailable: boolean;
    mutableItems: number;
  } {
    const snap = isAggregate(view)
      ? view.activeBinding?.kind === "bound"
        ? view.activeBinding.snapshot
        : { available: false, degraded: view.activeBinding?.kind === "ambiguous" }
      : view;
    const checklist =
      snap.available && snap.checklist && snap.checklist.mode === "checkbox" && snap.checklist.total > 0
        ? snap.checklist
        : null;
    return {
      taskId: snap.taskId ?? null,
      taskPath: snap.taskPath ?? null,
      checklistAvailable: checklist !== null,
      mutableItems: checklist ? checklist.items.filter((i) => i.kind === "checkbox").length : 0,
    };
  }

  function startPoll(ctx: ExtensionContext): void {
    stopPoll();
    const g = generation;
    pollTimer = setInterval(() => {
      if (g !== generation || polling) return;
      polling = true;
      try {
        const snap = load(ctx);
        if (!current || snapshotKey(snap) !== snapshotKey(current)) {
          current = snap;
          render(ctx);
        }
      } catch {
        /* degrade silently; next tick retries */
      } finally {
        polling = false;
      }
    }, POLL_MS);
  }

  pi.on("session_start", async (_e, ctx) => {
    activate(ctx);
  });

  pi.on("before_agent_start", async (_e, ctx) => {
    refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    stopPoll();
    current = null;
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(WIDGET_KEY, undefined);
    }
  });

  // ── Tool: trellis_task_board ───────────────────────────────────────
  let toolRegistered = false;
  function registerBoardTool(): void {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: "trellis_task_board",
      label: "Trellis Task Board",
      description:
        "List the current Trellis task board or mark a checkbox item completed within the active task's implement.md. Only set_completed mutates, and only a real checkbox checklist in a trusted Trellis task.",
      promptSnippet: "List the current Trellis task board or mark a checklist item completed",
      promptGuidelines: [
        "Use trellis_task_board to inspect the current Trellis task and its execution checklist instead of guessing from files.",
        "Use trellis_task_board list before set_completed to get the exact item number and expectedText.",
      ],
      parameters: BOARD_TOOL_PARAMS,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const identity = sessionIdentity(ctx);
        const trusted = ctx.isProjectTrusted();

        if (params.action === "list") {
          const view = loadBoard(ctx.cwd, identity, trusted);
          const writableSnapshot = loadWritableSnapshot(ctx.cwd, identity, trusted);
          const text = renderFullListLines(view).join("\n") || "无 Trellis 任务看板。";
          return {
            content: [{ type: "text", text }],
            details: {
              mode: viewMode(view),
              available: isAggregate(view) ? view.activeBinding?.kind === "bound" : view.available,
              degraded: isAggregate(view) ? view.activeBinding?.kind === "ambiguous" : view.degraded,
              reason: isAggregate(view)
                ? view.activeBinding?.kind === "ambiguous" ? "ambiguous-active-binding" : view.activeBinding?.kind === "unbound" ? "no-session" : null
                : (view.reason ?? null),
              status: writableSnapshot.statusRaw ?? null,
              taskId: writableSnapshot.taskId ?? null,
              activeBinding: isAggregate(view) ? view.activeBinding?.kind ?? "unbound" : view.available ? "bound" : "unbound",
              workspaceRoot: isAggregate(view) ? view.root : view.root ?? null,
              cwdRoot: isAggregate(view) ? view.cwdRoot ?? null : view.root ?? null,
              writable: writableScope(view),
              repositories: isAggregate(view)
                ? view.repositories.map((r) => ({
                    packageName: r.packageName,
                    relativePath: r.relativePath,
                    root: r.root,
                    readOnly: true,
                    counts: r.counts,
                    warnings: r.warnings,
                  }))
                : [],
            },
          };
        }

        // set_completed never accepts a repository or task path. It resolves
        // the unique current-session binding across discovered roots, while
        // every repository overview row stays read-only.
        const snap = loadWritableSnapshot(ctx.cwd, identity, trusted);

        if (!snap.available) {
          return {
            content: [
              {
                type: "text",
                text:
                  snap.reason === "untrusted"
                    ? "看板未激活：项目不受信任。"
                    : snap.reason === "ambiguous-active-binding"
                      ? "当前会话在多个 Trellis 根中绑定任务；拒绝猜测或写入。"
                      : "当前会话未绑定执行任务；无法修改。",
              },
            ],
            details: { ok: false },
          };
        }

        const result = await setCompleted(ctx.cwd, identity, trusted, {
          item: params.item ?? 0,
          expectedText: params.expectedText ?? "",
          completed: params.completed ?? false,
        });
        if (result.ok && result.changed) refresh(ctx);
        return {
          content: [{ type: "text", text: result.message }],
          details: { ok: result.ok, changed: result.changed ?? false },
        };
      },
    });
  }

  // ── Command: /trellis-tasks ────────────────────────────────────────
  pi.registerCommand("trellis-tasks", {
    description: "Show the full Trellis task board (scrollable in TUI)",
    handler: async (_args, ctx) => {
      const snap = refresh(ctx);
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") {
        // Concise non-TUI fallback: surface the summary in the footer status.
        ctx.ui.setStatus(
          WIDGET_KEY,
          isAggregate(snap)
            ? aggregateSummary(snap)
            : snap.degraded
              ? `! ${formatReason(snap.reason)}`
              : formatStatus(snap),
        );
        return;
      }
      const lines = renderFullListLines(snap, { width: 10_000 });
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let offset = 0;
        const pageSize = 18;
        const header = lines[0] ?? "trellis-task-board";
        const content = lines.slice(1);
        const total = content.length;
        const maxOffset = () => Math.max(0, total - pageSize);
        function render(w: number): string[] {
          const visible = content.slice(offset, offset + pageSize);
          const out: string[] = [theme.fg("accent", truncateToWidth(header, w))];
          for (const line of visible) {
            out.push(truncateToWidth(line, w));
          }
          const from = total === 0 ? 0 : offset + 1;
          const to = Math.min(total, offset + pageSize);
          out.push(theme.fg("dim", `  ↑/↓ 行 · PgUp/PgDn 页 · q/Esc 关闭 · ${from}-${to}/${total}`));
          return out;
        }
        return {
          render,
          handleInput(data: string): boolean {
            if (matchesKey(data, Key.up)) {
              offset = Math.max(0, offset - 1);
              tui.requestRender();
              return true;
            }
            if (matchesKey(data, Key.pageUp)) {
              offset = Math.max(0, offset - pageSize);
              tui.requestRender();
              return true;
            }
            if (matchesKey(data, Key.down)) {
              offset = Math.min(maxOffset(), offset + 1);
              tui.requestRender();
              return true;
            }
            if (matchesKey(data, Key.pageDown)) {
              offset = Math.min(maxOffset(), offset + pageSize);
              tui.requestRender();
              return true;
            }
            if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
              done();
              return true;
            }
            return false;
          },
          invalidate() {
            /* nothing cached */
          },
        };
      });
    },
  });
}