/**
 * Diff surface classification. Risk is a property of the source change, not of
 * the PR's byte size: build outputs and docs inflate file/line counts without
 * adding review surface. Everything downstream (risk gate + reviewer diff)
 * shares this one classifier so the two can never disagree.
 */

export type DiffFileStatus = 'new' | 'deleted' | 'modified';
export type PathKind = 'generated' | 'docs' | 'tests' | 'code';

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  added: number;
  deleted: number;
  /** This file's own `diff --git` block, verbatim. */
  patch: string;
}

export interface PathPolicy {
  generated: readonly string[];
  docs: readonly string[];
}

/** Machine-written files reproducible from source. Never review surface. */
export const DEFAULT_GENERATED_PATHS: readonly string[] = [
  'dist/**', '**/dist/**',
  'build/**', '**/build/**',
  '*.generated.*', '**/*.generated.*',
  '*.min.*', '**/*.min.*',
  '*.map', '**/*.map',
];

export const DEFAULT_DOC_PATHS: readonly string[] = [
  'docs/**', '**/docs/**',
  '*.md', '**/*.md',
];

export const SENSITIVE_PATH = /(^|\/)(auth|security|secrets?|crypto|permissions?)(\/|\.|$)|(^|\/)\.github\/workflows\//i;
export const BUILD_PATH = /(^|\/)(Dockerfile|docker-compose\.ya?ml|Makefile)$|(^|\/)(migrations?|schema)\//i;
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
export const DEPENDENCY_PATH = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i;
const LOCK_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i;
const DEP_KEYS = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|engines|packageManager|overrides|resolutions)"\s*:/;
const VERSION_VALUE = /"\s*:\s*"(?:[\^~]|>=|<=|=|>|<)?\d/;

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; }
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export const DEFAULT_POLICY: PathPolicy = {
  generated: DEFAULT_GENERATED_PATHS,
  docs: DEFAULT_DOC_PATHS,
};

export function classifyPath(path: string, policy: PathPolicy = DEFAULT_POLICY): PathKind {
  if (matchesAny(path, policy.generated)) return 'generated';
  if (matchesAny(path, policy.docs)) return 'docs';
  if (TEST_PATH.test(path)) return 'tests';
  return 'code';
}

/** git quotes unusual paths as `"a/x y"` with C-style escapes (spaces, and
 *  octal-escaped UTF-8 when core.quotepath is on); decode so classification
 *  sees the real path instead of leaking the block into the previous file. */
const DIFF_GIT_HEADER = /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/\S+) ("b\/(?:[^"\\]|\\.)*"|b\/\S+)$/;

function unquotePath(token: string): string {
  if (!token.startsWith('"')) return token;
  const inner = token.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = inner[++i];
    if (next === undefined) break;
    const mapped = simple[next];
    if (mapped !== undefined) { bytes.push(mapped); continue; }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length - 1; continue; }
    bytes.push(0x5c, ...Buffer.from(next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function splitDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = DIFF_GIT_HEADER.exec(line);
      // An unparsable header keeps its own block under a sentinel path so it
      // can never merge into (or silently drop) a neighbouring file — and a
      // sentinel never matches generated/docs globs, so it lands as code.
      const path = header ? unquotePath(header[2]!).slice(2) : line;
      current = { path, status: 'modified', added: 0, deleted: 0, patch: line + '\n' };
      files.push(current);
      continue;
    }
    if (!current) continue;
    current.patch += line + '\n';
    if (line.startsWith('new file mode')) current.status = 'new';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deleted++;
  }
  return files;
}

/**
 * Drop generated files from the reviewer's diff, replacing them with an
 * explicit header so a missing chunk reads as "intentionally omitted", never
 * as a truncated diff.
 */
export function filterGenerated(patch: string, policy: PathPolicy = DEFAULT_POLICY): { patch: string; omitted: string[] } {
  const files = splitDiff(patch);
  if (files.length === 0) return { patch, omitted: [] };
  const omitted: string[] = [];
  let out = '';
  for (const file of files) {
    if (classifyPath(file.path, policy) === 'generated') omitted.push(file.path);
    else out += file.patch;
  }
  if (omitted.length === 0) return { patch, omitted };
  const header = [
    `# 已省略 ${omitted.length} 个生成物文件（由源码构建产出，不参与评审）：`,
    ...omitted.map((path) => `#   ${path}`),
    '',
  ].join('\n');
  return { patch: header + out, omitted };
}

/** Thresholds count source files only — docs, tests and generated output have
 *  their own rules and must not push a change over the size gate. */
export function codeStats(files: readonly DiffFile[], policy: PathPolicy = DEFAULT_POLICY): { files: number; lines: number } {
  let count = 0;
  let lines = 0;
  for (const file of files) {
    if (classifyPath(file.path, policy) !== 'code') continue;
    count++;
    lines += file.added + file.deleted;
  }
  return { files: count, lines };
}

/** A package.json edit is a dependency risk only when it touches dependency
 *  declarations. Adding an npm script is ordinary code, not a supply-chain
 *  change. Lock files always count. */
export function touchesDependencies(file: DiffFile): boolean {
  if (!DEPENDENCY_PATH.test(file.path)) return false;
  if (LOCK_FILE.test(file.path)) return true;
  for (const line of file.patch.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const body = line.slice(1);
    if (DEP_KEYS.test(body) || VERSION_VALUE.test(body)) return true;
  }
  return false;
}
