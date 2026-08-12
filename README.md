# Trellis Task Board (Pi Package)

A [Pi](https://pi.dev) package that renders a persistent **`trellis-task-board`**
widget above the editor from trusted Trellis task files. It separates two facts
that Trellis intentionally keeps independent:

- **Workspace progress:** lifecycle/checklist summaries for the outer workspace
  and its nested Trellis repositories.
- **Current execution binding:** the one task explicitly bound to the current
  Pi session, if exactly one discovered Trellis root has that binding.

The package never chooses a task from status or timestamps. An `in_progress`
task from another Pi session contributes to the overview but is not presented
as the current session's executing task.

- **License:** MIT — see [LICENSE](./LICENSE).
- **Source of truth:** `.trellis/.runtime/sessions/`, direct non-archive task
  directories, `task.json`, `implement.md`, optional `config.yaml` packages,
  and safe root-task `meta.owner-repo` / `meta.local-task` mappings.

---

## Installation

Install at user scope so the board works in any trusted Trellis project without
changing project `.pi/settings.json`:

```bash
pi install git:github.com/Physicalyy/pi-trellis-task-board
```

For reproducible installs, pin a release or commit:

```bash
pi install git:github.com/Physicalyy/pi-trellis-task-board@v0.1.0
```

Local validation and removal:

```bash
pi -e /absolute/path/to/pi-trellis-task-board
pi install /absolute/path/to/pi-trellis-task-board
pi remove  /absolute/path/to/pi-trellis-task-board
pi remove git:github.com/Physicalyy/pi-trellis-task-board
```

---

## Workspace discovery

After `ctx.isProjectTrusted()` succeeds, the extension:

1. canonicalizes `cwd` and collects Trellis roots on its ancestor chain;
2. uses the nearest root as the **cwd repository** and the outermost root as the
   **workspace boundary**;
3. merges nested repositories from, in priority order:
   - valid root `config.yaml` `packages.<name>.path` entries;
   - safe root task `meta.owner-repo` paths;
   - bounded read-only discovery inside the canonical workspace root;
4. canonicalizes and realpath-deduplicates every repository.

Automatic discovery means a workspace without `packages` configuration still
shows nested Trellis repositories when Pi starts at the workspace root, a child
repository root, or a business subdirectory. Explicit packages remain supported
and keep their configured display names.

Discovery does **not** recursively search the disk. It remains inside the outer
workspace, does not traverse directory symlinks, rejects symlink escapes, has a
fixed depth and directory budget, and skips management/build/cache directories
including `.git`, `.trellis`, `node_modules`, `dist`, `build`, `target`,
`coverage`, `.cache`, `.next`, `.nuxt`, `.turbo`, and hidden directories.
Archive tasks are excluded. Local read failures and budget exhaustion become
visible diagnostics without hiding repositories that were read safely.

A project with no nested repositories keeps the single-root board behavior.
Untrusted and non-Trellis projects deactivate quietly.

---

## Session binding and mutation

The same current Pi `SessionIdentity` is resolved independently in the workspace
root and every discovered child root:

- **0 matches:** overview remains visible with `当前会话未绑定执行任务`;
- **1 match:** overview plus that task's ordered checklist are shown;
- **2+ matches:** a binding ambiguity warning is shown and the extension refuses
  to guess or write.

In multi-root mode only explicit current-session key candidates are accepted.
The single-file historical session fallback remains available for compatible
single-root projects, but is not used to turn another session into a current
workspace binding.

### Model tool: `trellis_task_board`

- `list` returns the board, workspace/cwd roots, active-binding state, and marks
  repository summaries read-only.
- `set_completed` accepts only a 1-based checkbox number, exact expected text,
  and desired checked state. It accepts no repository, task, or filesystem path.

`mutation.ts` remains the only product write boundary. For a uniquely bound
root (workspace or child), `set_completed` re-resolves the complete workspace
binding inside `withFileMutationQueue`, canonicalizes `implement.md`, checks
containment and expected text again, then changes exactly one ASCII marker
(`[ ]` ↔ `[x]`) while preserving all other bytes and line endings. Unbound,
ambiguous, planning, legacy, malformed, stale, escaped, and untrusted states are
read-only. No other repository can be selected by tool parameters.

---

## Widget and `/trellis-tasks`

The compact widget is capped at eight lines in workspace mode and prioritizes:

1. `trellis-task-board` plus aggregate completed/total task lifecycle count;
2. current session binding, or an explicit unbound/ambiguous message;
3. a source-contiguous checklist window for the uniquely bound task;
4. repository summaries and a narrow-safe `/trellis-tasks` fold marker.

`/trellis-tasks` opens the full scrollable board in TUI mode and uses a concise
footer elsewhere. It shows all non-archive repository tasks, diagnostics,
mappings, and read-only checklists. Only the uniquely bound writable checklist
has 1-based mutation numbers.

### Checkbox semantics

Checkbox output intentionally has no inferred “currently executing checklist
item” state:

- `✓` — completed checkbox;
- `□` — unchecked checkbox;
- `·` — legacy/read-only plan item;
- `?` — malformed or unknown row/task state where applicable.

Checklist rows remain in `implement.md` source order. The first `□` is naturally
the next ordered item, but the board does not relabel it as `→ 下一步` or claim
that work has started. Compact windows are contiguous source slices; when rows
after the slice are hidden, `… 还有 N 项` reports the exact hidden row count.

### Theme and accessibility

All color and emphasis comes from Pi's current theme API; the package contains
no fixed ANSI colors, RGB values, or terminal palette assumptions:

- completed `✓` and body are dim; completed body is struck through;
- every pending `□` glyph uses `accent`;
- only the first pending body uses `accent` + bold;
- later pending bodies use normal `text`;
- paths/counts/truncation use muted/dim styling;
- diagnostics use warning/error roles.

Styling is segmented rather than painting the whole board accent. Glyphs,
source order, lifecycle words, explicit binding text, and read-only labels keep
all meaning available without color. Plain semantic segments are CJK-width
bounded before theme styling; tests cover ANSI output at 32, 48, and 80 columns.

---

## Truthful status model

| `task.json.status` | Display |
| --- | --- |
| `planning` | `规划 · 阶段 1 · 等待激活`; no execution ratio |
| `in_progress` | `进行中 · 阶段 2/3 · N/M` only with a real checkbox checklist |
| `completed` | `已完成 · 阶段 3` |
| `review` / unknown | distinct review/raw status; no invented phase precision |

Repository `completed/total` counts non-archive task lifecycle statuses only;
checklist rows are never added to that ratio. Missing machine-readable progress
is `进度不可计算`, never fabricated `0/N`. A `!` row is a board data-quality or
safety diagnostic, never an inferred task blocker.

---

## Compatibility and security

- **Supported:** Pi CLI 0.84.x, Node.js ≥ 20.
- **Runtime dependency:** `yaml`; Pi-owned packages remain peer dependencies.
- **Reads:** trusted workspace only; canonical realpath containment protects
  workspace, `.trellis`, tasks, packages, metadata references, and discovery.
- **Writes:** exactly one checkbox marker in the uniquely current-session-bound
  task's existing canonical `implement.md`; never arbitrary paths or multiple
  roots.
- **Never modified:** Trellis scripts/workflows/templates, project Pi settings,
  session pointers, target-project configuration, archives, or unrelated tasks.

> Pi packages execute with full system access. Review third-party package source
> before installation.

---

## Development

```bash
npm ci
npm run typecheck
npm test
npm run pack:check
```

---

## License

MIT — see [LICENSE](./LICENSE).
