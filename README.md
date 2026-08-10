# Trellis Task Board (Pi Package)

A [Pi](https://pi.dev) package that renders a persistent **`trellis-task-board`**
widget above the editor, synced with the current project's Trellis task files.
It shows the active task, its real lifecycle status, the coarse workflow phase,
checkbox completion progress and the current step — without asking the AI to
report on it.

In **polyrepo workspaces** the widget becomes a multi-root aggregate board: it
keeps showing the workspace coordination task while also summarizing each
repository declared in the root `.trellis/config.yaml` `packages` map (all its
non-archived tasks, lifecycle counts and checklist progress).

- **License:** MIT — see [LICENSE](./LICENSE).
- **Source of truth:** the project's own Trellis runtime files
  (`.trellis/.runtime/sessions/<key>.json`, `task.json`, and `implement.md`),
  plus `.trellis/config.yaml` `packages` for multi-root discovery. No separate
  session todo list is created.

---

## Installation

Install at **user scope** (default) so the board serves any trusted Trellis
project without touching the project's `.pi/settings.json`:

```bash
pi install git:github.com/Physicalyy/pi-trellis-task-board
```

> The `-l` (project-local) flag is intentionally **not** used. This package is
> recorded in `~/.pi/agent/settings.json`, outside Trellis-managed files.

### Reproducible (pinned ref) install

For repeatable team installs, pin a released tag or commit. Pinned refs are
reconciled by `pi update` but never advanced to a newer ref automatically —
changing the ref requires an explicit install/update decision:

```bash
pi install git:github.com/Physicalyy/pi-trellis-task-board@v0.1.0
```

### Local / latest-channel validation

```bash
pi -e /absolute/path/to/pi-trellis-task-board          # ephemeral load, no install
pi install /absolute/path/to/pi-trellis-task-board     # local path (reversible)
pi remove  /absolute/path/to/pi-trellis-task-board     # remove the identical source
```

### Uninstall

Remove with the exact installed source:

```bash
pi remove git:github.com/Physicalyy/pi-trellis-task-board
```

---

## Usage

The widget mounts above the editor with the visible title `trellis-task-board`
when all of these hold:

1. the project is trusted by Pi (`ctx.isProjectTrusted()`);
2. walking up from the current directory finds a `.trellis/` nearest ancestor;
3. a current task can be uniquely resolved for the Pi session.

Non-Trellis, untrusted, no-task, ambiguous-session and malformed states simply
deactivate the widget or show a safe localized `!` degradation note — the board
never fabricates approval, blockers or an exact Phase 3 position.

For checkbox plans, the compact widget shows recent completed context, labels
the first unchecked item as `→ 下一步` (next step, not proven in-progress), and
uses `□` for later pending items. `后续 N 项` counts only genuinely unchecked
items hidden after the compact window; hidden completed history is not reported
as remaining work. Fixed UI and mutation messages are displayed in Simplified
Chinese. Task text itself remains exactly as authored in `implement.md`.

### Multi-root aggregate mode

When the trusted root `.trellis/config.yaml` declares a non-empty `packages`
map, the board switches to a two-layer aggregate view:

- **Workspace layer:** the root's current task (title, lifecycle status and
  checklist ratio), or an explicit `无当前任务` when the session has no task.
- **Repository layer:** one row per declared package with its completed/total
  (task lifecycle counts over non-archived tasks only) plus status counts
  (`in_progress` / `planning` / `review` / `unknown` / `completed`), and the
  first in-progress task's checklist progress when space allows. The widget is
  hard-capped at 8 rows; repositories that do not fit fold into
  `+N 个仓库折叠（/trellis-tasks 查看全部）`.

Package discovery is explicit only:

- Packages come solely from the root `config.yaml` `packages` map — never a
  recursive scan of nested `.trellis/` directories.
- Only the `path` field is used; `git`, `type` and other fields are ignored.
- Every package/task path must pass realpath containment inside the workspace
  root; package self-reference (pointing at the root itself) is rejected and
  canonical duplicates are deduplicated.
- `.trellis/tasks/archive/` is fully excluded from every repository: archived
  tasks never appear in the list and never count toward completed/total.

The workspace task (and its active direct children) can link to repository
tasks through `task.json.meta.owner-repo` + `meta.local-task`. The link only
**reports** a coordination-vs-implementation status difference; it never syncs
or rewrites either side. Missing or invalid mappings produce a localized
warning without hiding the repository's own task overview.

Configuration outcomes are distinct:

- `packages` missing/empty → plain single-root board (no aggregate view).
- `packages` declared but unparseable/malformed or every entry rejected →
  aggregate-degraded view that keeps the workspace task and shows per-entry
  diagnostics; it never silently falls back to the single-root style.
- At least one valid package → normal aggregate view; invalid packages are
  localized diagnostics next to the valid repositories.

### `/trellis-tasks`

Opens a full, scrollable list of the board in TUI mode (↑/↓ or PgUp/PgDn to
scroll, `q`/`Esc` to close) with a concise footer fallback elsewhere. In
aggregate mode it lists the workspace task, the root writable scope, every
configured repository's non-archived tasks with checklist progress, all
links/status differences and every diagnostic.

### Model tool: `trellis_task_board`

- `list` — return the current board without writing. In aggregate mode the
  output separates the **root writable scope** (the root current task's
  mutable checkbox list, numbered 1-based) from the **read-only sub-repository
  lists** (glyphs only, no mutation numbers, so a sub-repository item can never
  be targeted by `set_completed`).
- `set_completed` — toggle a single checkbox in `implement.md`
  (`item` = 1-based number, `expectedText` = exact item text, `completed`).
  It only ever targets the **current Trellis root's current task**; it accepts
  no repository or task path, so sub-repository aggregate data stays read-only.

`set_completed` is available only for a real checkbox checklist in a trusted
Trellis task. Legacy numbered plans and planning-state tasks are read-only.

---

## What the board shows (and never shows)

| `task.json.status` | Board display |
| --- | --- |
| `planning` | `规划 · 阶段 1 · 等待激活` (PRD/Design/Plan/context gates), even if `implement.md` already exists |
| `in_progress` | `进行中 · 阶段 2/3 · N/M` when a checkbox checklist exists; otherwise `进行中 · 阶段 2/3` with no fabricated ratio |
| `completed` | `已完成 · 阶段 3` |
| `review` / unknown | localized review label or raw sanitized unknown status, with no invented phase precision |

Repository `completed/total` counts task lifecycle status only (non-archived
tasks); per-task checklist items are never summed into a repository ratio.
When a checklist has no machine-readable progress the board says
`进度不可计算` instead of inventing `0/N`. `!` always means *board data
degraded/unreadable* (missing, malformed, ambiguous or unsafe files) — never a
fabricated task blocker.

---

## Compatibility & security boundary

- **Supported:** Pi CLI 0.84.x, Node.js ≥ 20.
- **Runtime dependency:** `yaml` (used to parse `.trellis/config.yaml`
  `packages`). Pi-owned modules are `peerDependencies` with matching dev copies
  for standalone type-checking/tests.
- **Reads:** only trusted Trellis projects. Path containment is realpath-based
  (`node:path.relative`), so traversal, absolute external refs and symlink
  escapes are rejected. Aggregate discovery reads only the declared packages
  and their `.trellis/tasks/`; it never touches archived tasks or unconfigured
  directories.
- **The only write:** one ASCII checkbox marker (`[ ]` ↔ `[x]`) in an existing
  canonical `implement.md` inside the **current root's** `.trellis/tasks/`. It
  never creates files and never accepts an arbitrary path (and no sub-repository
  path is ever writable). The write re-resolves the session, task and file
  inside `withFileMutationQueue` and re-validates the item text.
- **Never modified:** `.trellis/scripts/`, `.trellis/workflow.md`,
  `.pi/extensions/trellis/`, project `.pi/settings.json`, official
  agents/prompts/skills, any sub-repository Trellis task, or any other
  Trellis-managed file.
- **Session pointer** (`.trellis/.runtime/sessions/`) is local-only and
  gitignored; the board reflects the local dev's current task. If a task is
  started from a plain terminal without `TRELLIS_CONTEXT_ID`, no session file is
  written and the workspace block shows "no task" — an expected degradation,
  not a bug. With a valid `packages` declaration the repository layer still
  renders.

> **Security note:** Pi packages execute with full system access. Review the
> source before installing third-party packages. This package's only system
> mutation is the checkbox marker described above.

---

## Development

```bash
npm ci
npm run typecheck
npm test
npm run pack:check        # npm pack --dry-run
```

The parser, state loader, aggregate state, key algorithms and width helpers are
pure Node and are covered by unit tests. `extension`/`task-state` loading and
the widget visuals are validated in an interactive Pi session (see the widget
above and `/trellis-tasks`).

---

## License

MIT — see [LICENSE](./LICENSE).
