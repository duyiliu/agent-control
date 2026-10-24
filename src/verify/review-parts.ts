import { MAX_REVIEW_DIFF_CHARS } from '../scheduler/prompts.js';

export const MAX_REVIEW_PARTS = 8;
const PART_SIZE = MAX_REVIEW_DIFF_CHARS - 4_000;

export function reviewParts(diff: string): string[] | null {
  if (/\.\.\.\[truncated \d+ (?:chars|bytes)\]/.test(diff)) return null;
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return [diff];
  const files = diff.split(/(?=^diff --git )/m);
  const units: string[] = [];
  for (const file of files) {
    if (file.length <= PART_SIZE) { units.push(file); continue; }
    const start = file.search(/^@@ /m);
    if (start < 0) return null;
    const header = file.slice(0, start);
    for (const hunk of file.slice(start).split(/(?=^@@ )/m)) {
      if (header.length + hunk.length > PART_SIZE) return null;
      units.push(header + hunk);
    }
  }
  const parts: string[] = [];
  let part = '';
  for (const unit of units) {
    if (part && part.length + unit.length > PART_SIZE) { parts.push(part); part = ''; }
    part += unit;
  }
  if (part) parts.push(part);
  return parts.length <= MAX_REVIEW_PARTS ? parts : null;
}
