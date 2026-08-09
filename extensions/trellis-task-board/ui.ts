/**
 * Pure, ANSI/CJK width-safe formatting for the bounded widget and the full
 * `/trellis-tasks` list. Node-only so it can be unit-tested standalone.
 */

import type { ChecklistItem } from "./checklist.ts";
import type { BoardSnapshot } from "./task-state.ts";

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero width space
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0x0300 && cp <= 0x036f) // combining diacritics
  );
}

/** Visible display width ignoring ANSI SGR escapes, counting CJK as 2. */
export function visibleWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  let w = 0;
  for (const ch of Array.from(clean)) {
    const cp = ch.codePointAt(0)!;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** Truncate a plain string so its visible width does not exceed `width`. */
export function truncateToWidth(s: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    if (isZeroWidth(cp)) {
      out += ch;
      continue;
    }
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > width) break;
    w += cw;
    out += ch;
  }
  return out;
}

/** Truthful lifecycle-to-display mapping. Never invents approval/blocker/exact Phase 3. */
export function formatStatus(snapshot: BoardSnapshot): string {
  const raw = snapshot.statusRaw ?? "";
  if (snapshot.planning) return "PLANNING · Phase 1 · awaiting activation";
  if (raw === "in_progress") {
    const c = snapshot.checklist;
    if (c && c.mode === "checkbox" && c.total > 0) {
      return `ACTIVE · Phase 2/3 · ${c.completed}/${c.total}`;
    }
    return "ACTIVE · Phase 2/3";
  }
  if (raw === "completed") return "COMPLETED · Phase 3";
  if (raw === "review") return "REVIEW";
  if (raw) return raw.replace(/[-_]+/g, " ").toUpperCase();
  return "UNKNOWN STATUS";
}

function itemGlyph(item: ChecklistItem, isCurrent: boolean): string {
  if (item.kind === "legacy") return "·";
  if (item.kind === "malformed") return "?";
  if (item.checked) return "✓";
  return isCurrent ? "●" : "○";
}

function renderItemLine(item: ChecklistItem, isCurrent: boolean): string {
  const glyph = itemGlyph(item, isCurrent);
  const text = item.normalized || "(empty)";
  return `${glyph} ${text}`;
}

export interface WidgetRenderOptions {
  width?: number;
  maxRows?: number;
}

/**
 * Render the bounded above-editor widget lines. The visible title is always
 * `trellis-task-board`; the surface is one header plus up to `maxRows` rows.
 */
export function renderWidgetLines(snapshot: BoardSnapshot, opts?: WidgetRenderOptions): string[] {
  const width = opts?.width ?? 80;
  const maxRows = opts?.maxRows ?? 3;
  const lines: string[] = [];

  const title = "trellis-task-board";
  const status = snapshot.degraded ? "!" : formatStatus(snapshot);
  const headerLine = title + " ".repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(status))) + status;
  lines.push(truncateToWidth(headerLine, width).replace(/\s+$/, ""));

  if (snapshot.degraded) {
    lines.push(`! ${snapshot.reason ?? "board degraded"}`);
    if (snapshot.taskName) lines.push(`· ${snapshot.taskName}`);
    return lines;
  }
  if (!snapshot.available) {
    lines.push("· Inactive (no trusted Trellis task)");
    return lines;
  }

  if (snapshot.planning) {
    lines.push("· PRD / Design / Plan / context material");
    lines.push("· Awaiting activation (status: planning)");
    return lines;
  }

  const c = snapshot.checklist;
  if (!c || c.items.length === 0) {
    lines.push("· No machine-readable checklist");
    return lines;
  }

  const firstUnchecked = c.items.findIndex((i) => i.kind === "checkbox" && !i.checked);
  const rows = c.items.slice(0, maxRows);
  const more = c.items.length - rows.length;
  for (let i = 0; i < rows.length; i++) {
    let line = renderItemLine(rows[i], i === firstUnchecked);
    if (i === rows.length - 1 && more > 0) {
      line = `${line}  +${more} more`;
    }
    lines.push(truncateToWidth(line, width));
  }

  return lines.map((l) => truncateToWidth(l, width));
}

/** Full, scrollable-safe list used by `/trellis-tasks` (and its non-TUI fallback). */
export function renderFullListLines(snapshot: BoardSnapshot, opts?: { width?: number }): string[] {
  const width = opts?.width ?? 100;
  const out: string[] = [];
  const status = snapshot.degraded ? "!" : formatStatus(snapshot);
  const title = `trellis-task-board  ${snapshot.available ? "·" : ""} ${status}`;
  out.push(truncateToWidth(title, width));

  if (snapshot.degraded) {
    out.push(`  ! ${snapshot.reason ?? "board degraded"}`);
    return out;
  }
  if (!snapshot.available) {
    out.push("  Inactive: no trusted Trellis task.");
    return out;
  }

  const name = snapshot.taskName || snapshot.taskId || "(untitled task)";
  const idLine = snapshot.taskId ? `${snapshot.taskId} — ${name}` : name;
  out.push(truncateToWidth(`  Task: ${idLine}`, width));
  out.push(truncateToWidth(`  Status: ${snapshot.statusRaw ?? "unknown"}`, width));
  out.push("");

  const c = snapshot.checklist;
  if (snapshot.planning) {
    out.push("  Phase 1 · Plan");
    out.push("  Gates: PRD / Design / Plan / context material");
    out.push("  Awaiting task activation (status: planning)");
    out.push("");
    out.push("  No execution progress is shown while planning.");
    return out;
  }
  if (!c || c.items.length === 0) {
    out.push("  No machine-readable execution checklist.");
    out.push("  Progress unavailable.");
    return out;
  }

  if (c.mode === "legacy") {
    out.push("  Legacy numbered plan — progress unavailable (read-only).");
    out.push("");
    c.items.forEach((item, i) => {
      out.push(truncateToWidth(`  ${i + 1}. ${item.text}`, width));
    });
    return out;
  }

  const firstUnchecked = c.items.findIndex((i) => i.kind === "checkbox" && !i.checked);
  c.items.forEach((item, i) => {
    const glyph = itemGlyph(item, i === firstUnchecked);
    out.push(truncateToWidth(`  ${glyph} ${item.text}`, width));
  });
  return out;
}