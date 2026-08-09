/**
 * Fenced-code-aware checklist and legacy numbered-plan parsing.
 *
 * This module is intentionally pure (Node only, no Pi imports) so it can be
 * unit-tested standalone. It parses the execution checklist of a Trellis
 * `implement.md` and provides a constrained single-character mutation helper
 * for real checkbox markers.
 *
 * Writing contract:
 * - Only `[ ]`, `[x]`, `[X]` markers are mutable checkboxes.
 * - `[~]` and any other marker character are read-only (malformed).
 * - Legacy numbered plans and the absence of a checklist are read-only.
 */

export type ItemKind = "checkbox" | "malformed" | "legacy";

export interface ChecklistItem {
  /** checkbox | malformed | legacy */
  kind: ItemKind;
  /** 0-based line index in the source text's line list */
  line: number;
  /** global char offset of the opening `[` of the marker (checkbox/malformed) */
  markerStart: number;
  /** global char offset of the closing `]` of the marker (checkbox/malformed) */
  markerEnd: number;
  /** true for `[x]` / `[X]` checkboxes */
  checked: boolean;
  /** raw text following the marker (may be empty) */
  text: string;
  /** whitespace-collapsed, case-folded, trimmed text used for expected-text matching */
  normalized: string;
}

export interface ChecklistParseResult {
  /** "checkbox" when a real checkbox checklist exists, "legacy" for a read-only numbered plan, "none" otherwise */
  mode: "checkbox" | "legacy" | "none";
  items: ChecklistItem[];
  /** number of checked checkboxes (0 for legacy/none) */
  completed: number;
  /** number of mutable checkbox items (0 for legacy/none) */
  total: number;
  /** false for legacy/none so the board never claims a computable 0/N */
  progressAvailable: boolean;
}

interface LineInfo {
  text: string;
  start: number;
}

const CHECKBOX = /^(\s*)[-*+]\s*\[([ xX~])\]\s?(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)][\t ]+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^(`{3,}|~{3,})/;

/** Split text into lines while recording each line's global start offset. */
function lineStarts(text: string): { content: string[]; starts: number[] } {
  const content: string[] = [];
  const starts: number[] = [];
  let start = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const idx = text.indexOf("\n", start);
    if (idx === -1) {
      content.push(text.slice(start));
      starts.push(start);
      break;
    }
    // include a trailing \r in the line so CRLF is preserved on the line
    const end = idx > start && text.charCodeAt(idx - 1) === 13 ? idx - 1 : idx;
    content.push(text.slice(start, end));
    starts.push(start);
    start = idx + 1;
    if (start >= text.length) {
      content.push(""); // trailing empty line keeps offsets consistent
      starts.push(start);
      break;
    }
  }
  return { content, starts };
}

/** Is this line inside a fenced code block? */
function buildFence(lines: LineInfo[]): boolean[] {
  const fence: boolean[] = new Array(lines.length).fill(false);
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i].text.trim())) {
      inCode = !inCode;
      fence[i] = true;
      continue;
    }
    fence[i] = inCode;
  }
  return fence;
}

export function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Find the `## Checklist` (case-insensitive) section until the next same/higher heading. */
function findChecklistSection(
  lines: LineInfo[],
  fence: boolean[],
): { start: number; end: number; level: number } | null {
  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = HEADING.exec(lines[i].text);
    if (!m) continue;
    if (startIdx === -1 && /checklist/i.test(m[2])) {
      startIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  let end = lines.length - 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = HEADING.exec(lines[i].text);
    if (m && m[1].length <= level) {
      end = i - 1;
      break;
    }
  }
  return { start: startIdx, end, level };
}

function collectCheckboxItems(
  lines: LineInfo[],
  fence: boolean[],
  range: { start: number; end: number },
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (let i = range.start; i <= range.end; i++) {
    if (fence[i]) continue;
    const line = lines[i].text;
    const m = CHECKBOX.exec(line);
    if (!m) continue;
    let open = line.indexOf("[");
    if (open === -1) open = 0;
    const markerStart = lines[i].start + open;
    const markerChar = m[2];
    const kind: ItemKind = /^[ xX]$/.test(markerChar) ? "checkbox" : "malformed";
    items.push({
      kind,
      line: i,
      markerStart,
      markerEnd: markerStart + 2,
      checked: kind === "checkbox" && (markerChar === "x" || markerChar === "X"),
      text: m[3],
      normalized: normalizeText(m[3]),
    });
  }
  return items;
}

function collectLegacyItems(
  lines: LineInfo[],
  fence: boolean[],
  range: { start: number; end: number },
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  let started = false;
  for (let i = range.start; i <= range.end; i++) {
    if (fence[i]) continue;
    const line = lines[i].text;
    if (HEADING.test(line)) {
      if (started) break; // numbered plan stops at the next heading
      continue; // skip the leading section heading
    }
    const m = NUMBERED.exec(line);
    if (!m) continue;
    started = true;
    items.push({
      kind: "legacy",
      line: i,
      markerStart: lines[i].start,
      markerEnd: lines[i].start,
      checked: false,
      text: m[3],
      normalized: normalizeText(m[3]),
    });
  }
  return items;
}

/**
 * Parse an `implement.md` body.
 *
 * Resolution order:
 * 1. A checklist section (heading matching /checklist/i) is located when present.
 * 2. Checkbox or malformed markers within it make it a checkbox board.
 * 3. Otherwise numbered lines within it form a read-only legacy plan.
 * 4. With no section, the whole file is scanned the same way (fences excluded).
 */
export function parseChecklist(text: string): ChecklistParseResult {
  const db = lineStarts(text);
  const lines: LineInfo[] = db.content.map((c, i) => {
    const hasBom = i === 0 && c.startsWith("\uFEFF");
    return { text: hasBom ? c.slice(1) : c, start: db.starts[i] + (hasBom ? 1 : 0) };
  });
  const fence = buildFence(lines);

  const section = findChecklistSection(lines, fence);
  const range = section ?? { start: 0, end: lines.length - 1 };

  const checkboxItems = collectCheckboxItems(lines, fence, range);
  if (checkboxItems.length > 0) {
    const mutable = checkboxItems.filter((i) => i.kind === "checkbox");
    return {
      mode: "checkbox",
      items: checkboxItems,
      completed: mutable.filter((i) => i.checked).length,
      total: mutable.length,
      progressAvailable: true,
    };
  }

  const legacy = collectLegacyItems(lines, fence, range);
  if (legacy.length > 0) {
    return { mode: "legacy", items: legacy, completed: 0, total: legacy.length, progressAvailable: false };
  }

  return { mode: "none", items: [], completed: 0, total: 0, progressAvailable: false };
}

/**
 * Apply a checkbox state change to raw file text, changing only the single
 * ASCII marker character. Preserves BOM, UTF-8 content and CRLF/LF bytes.
 * Throws when the item is not a mutable checkbox.
 */
export function applyMarkerChange(
  text: string,
  item: ChecklistItem,
  checked: boolean,
): { text: string; changed: boolean } {
  if (item.kind !== "checkbox") {
    throw new Error("Item is not a mutable checkbox; cannot change marker");
  }
  const at = item.markerStart + 1;
  const current = text.charAt(at);
  const next = checked ? "x" : " ";
  if (current === "[" || current === "]" || current === "") {
    throw new Error("Marker position is not inside checkbox brackets");
  }
  if (current === next) {
    return { text, changed: false };
  }
  return { text: text.slice(0, at) + next + text.slice(at + 1), changed: true };
}