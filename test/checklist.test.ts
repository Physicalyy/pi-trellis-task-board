import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMarkerChange,
  normalizeText,
  parseChecklist,
  type ChecklistItem,
} from "../extensions/trellis-task-board/checklist.ts";

test("parses a checkbox checklist with completed counts", () => {
  const md = `# T\n\n## Checklist\n\n- [ ] alpha\n- [x] bravo\n- [X] charlie\n- [ ] delta\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "checkbox");
  assert.equal(r.total, 4);
  assert.equal(r.completed, 2);
  assert.equal(r.progressAvailable, true);
  assert.deepEqual(
    r.items.map((i) => i.checked),
    [false, true, true, false],
  );
});

test("respects the checklist section boundary (next same/higher heading)", () => {
  const md = `# T\n\n## Checklist\n\n- [ ] one\n- [ ] two\n\n## Other\n\n- [ ] three\n`;
  const r = parseChecklist(md);
  assert.equal(r.total, 2);
  assert.ok(r.items.every((i) => i.normalized === "one" || i.normalized === "two"));
});

test("recognizes an Implementation Checklist heading case-insensitively", () => {
  const md = `# T\n\n## IMPLEMENTATION CHECKLIST\n\n- [ ] first\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "checkbox");
  assert.equal(r.total, 1);
});

test("ignores checkbox markers inside fenced code blocks", () => {
  const md = `# T\n\n## Checklist\n\n- [ ] real\n\n\`\`\`\n- [ ] fake\n\`\`\`\n\n- [ ] also-real\n`;
  const r = parseChecklist(md);
  assert.equal(r.total, 2);
  assert.ok(r.items.every((i) => i.normalized === "real" || i.normalized === "also-real"));
});

test("treats tilde and other markers as read-only malformed, not counted", () => {
  const md = `## Checklist\n\n- [ ] a\n- [~] pending\n- [ ] b\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "checkbox");
  assert.equal(r.total, 2);
  assert.equal(r.completed, 0);
  const malformed = r.items.find((i) => i.kind === "malformed");
  assert.ok(malformed);
  assert.equal(malformed.normalized, "pending");
});

test("parses a legacy numbered plan as read-only with progress unavailable", () => {
  const md = `## Checklist\n\n1. One\n2. Two\n3. Three\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "legacy");
  assert.equal(r.items.length, 3);
  assert.equal(r.progressAvailable, false);
  assert.equal(r.completed, 0);
  assert.ok(r.items.every((i) => i.kind === "legacy"));
});

test("legacy numbered plan stops at the next heading (validation/rollback)", () => {
  const md = `## Checklist\n\n1. One\n2. Two\n\n## Validation\n\n- manual step\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "legacy");
  assert.equal(r.items.length, 2);
});

test("returns none for empty or unrelated content", () => {
  assert.equal(parseChecklist("").mode, "none");
  assert.equal(parseChecklist("just some prose\n- not a checkbox").mode, "none");
});

test("scans the whole implementation plan when no Checklist heading exists", () => {
  const md = `# Implementation Plan\n\n## Phase A\n\n- [ ] first\n\n## Phase B\n\n- [x] second\n`;
  const r = parseChecklist(md);
  assert.equal(r.mode, "checkbox");
  assert.equal(r.total, 2);
  assert.equal(r.completed, 1);
  assert.deepEqual(
    r.items.map((i) => i.normalized),
    ["first", "second"],
  );
});

test("normalizeText collapses whitespace and case-folds", () => {
  assert.equal(normalizeText("  Hello    World  "), "hello world");
  assert.equal(normalizeText("Checklist"), "checklist");
});

test("applyMarkerChange flips only the exact marker character", () => {
  const md = `## Checklist\n\n- [ ] alpha\n`;
  const r = parseChecklist(md);
  const item = r.items[0];
  assert.ok(item);
  const { text, changed } = applyMarkerChange(md, item, true);
  assert.equal(changed, true);
  assert.ok(text.includes("- [x] alpha"));
  assert.equal(text.replace("- [x] alpha", ""), md.replace("- [ ] alpha", ""));
});

test("applyMarkerChange is a no-op when already in requested state", () => {
  const md = `## Checklist\n\n- [x] done\n`;
  const r = parseChecklist(md);
  const item = r.items[0];
  const { changed } = applyMarkerChange(md, item, true);
  assert.equal(changed, false);
});

test("applyMarkerChange preserves CRLF line endings and other content", () => {
  const md = `## Checklist\r\n\r\n- [ ] one\r\n- [ ] two\r\n## Footer\r\nkeep this\r\n`;
  const r = parseChecklist(md);
  const item = r.items.find((i) => i.normalized === "one");
  assert.ok(item);
  const { text, changed } = applyMarkerChange(md, item, true);
  assert.equal(changed, true);
  assert.ok(text.includes("- [x] one\r\n- [ ] two\r\n"));
  assert.ok(text.endsWith("keep this\r\n"));
  assert.equal(text.includes("\n") && !text.includes("\r\n"), false, "no bare LF introduced");
});

test("applyMarkerChange throws for legacy and malformed items", () => {
  const legacyMd = "## Checklist\n\n1. step\n";
  const legacy = parseChecklist(legacyMd);
  assert.throws(() => applyMarkerChange(legacyMd, legacy.items[0], true), /mutable checkbox/);
  const malformedMd = "## Checklist\n\n- [~] x\n";
  const malformed = parseChecklist(malformedMd);
  assert.throws(() => applyMarkerChange(malformedMd, malformed.items[0], true), /mutable checkbox/);
});

test("marker offsets are global and survive a BOM prefix", () => {
  const md = `\uFEFF## Checklist\n\n- [ ] item\n`;
  const r = parseChecklist(md);
  const item = r.items[0];
  assert.ok(item);
  // BOM is 1 char, so the '[' must be at a global offset >= the BOM position.
  assert.ok(item.markerStart > 0);
  const { text, changed } = applyMarkerChange(md, item, true);
  assert.equal(changed, true);
  assert.ok(text.startsWith("\uFEFF## Checklist"));
  assert.ok(text.includes("- [x] item"));
});