import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPath, codeStats, DEFAULT_POLICY, filterGenerated, splitDiff, touchesDependencies,
} from '../src/scheduler/diff-paths.js';

const PATCH = [
  'diff --git a/src/core.js b/src/core.js',
  'index 1111111..2222222 100644',
  '--- a/src/core.js',
  '+++ b/src/core.js',
  '@@ -1,2 +1,3 @@',
  '-old',
  '+new',
  '+more',
  'diff --git a/dist/scenario-test.cjs b/dist/scenario-test.cjs',
  'index 3333333..4444444 100644',
  '--- a/dist/scenario-test.cjs',
  '+++ b/dist/scenario-test.cjs',
  '@@ -1 +1 @@',
  '-bundled',
  '+rebundled',
  'diff --git a/docs/GUIDE.md b/docs/GUIDE.md',
  'index 5555555..6666666 100644',
  '--- a/docs/GUIDE.md',
  '+++ b/docs/GUIDE.md',
  '@@ -1 +1 @@',
  '-doc',
  '+docs',
  'diff --git a/tests/core.test.js b/tests/core.test.js',
  'index 7777777..8888888 100644',
  '--- a/tests/core.test.js',
  '+++ b/tests/core.test.js',
  '@@ -1 +1,2 @@',
  '-assert(x)',
  '+assert(x)',
  '+assert(y)',
].join('\n');

test('diff-paths: splitDiff parses per-file status and line counts', () => {
  const files = splitDiff(PATCH);
  assert.equal(files.length, 4);
  assert.deepEqual(files.map((f) => f.path), ['src/core.js', 'dist/scenario-test.cjs', 'docs/GUIDE.md', 'tests/core.test.js']);
  assert.equal(files[0]!.added, 2);
  assert.equal(files[0]!.deleted, 1);
  assert.equal(files[3]!.added, 2);
  assert.equal(files[3]!.deleted, 1);
});

test('diff-paths: classifyPath separates generated, docs, tests and code', () => {
  assert.equal(classifyPath('dist/scenario-test.cjs'), 'generated');
  assert.equal(classifyPath('packages/app/dist/bundle.js'), 'generated');
  assert.equal(classifyPath('src/version.generated.js'), 'generated');
  assert.equal(classifyPath('src/browser/tailwind.generated.js'), 'generated');
  assert.equal(classifyPath('docs/GUIDE.md'), 'docs');
  assert.equal(classifyPath('README.md'), 'docs');
  assert.equal(classifyPath('tests/core.test.js'), 'tests');
  assert.equal(classifyPath('src/__tests__/x.js'), 'tests');
  assert.equal(classifyPath('src/core.js'), 'code');
});

test('diff-paths: codeStats counts source files only', () => {
  const stats = codeStats(splitDiff(PATCH));
  assert.deepEqual(stats, { files: 1, lines: 3 });
});

test('diff-paths: generated files are dropped from the reviewer diff with an explicit header', () => {
  const { patch, omitted } = filterGenerated(PATCH);
  assert.deepEqual(omitted, ['dist/scenario-test.cjs']);
  assert.match(patch, /^# 已省略 1 个生成物文件/);
  assert.match(patch, /#   dist\/scenario-test\.cjs/);
  assert.ok(!patch.includes('diff --git a/dist/'));
  assert.ok(patch.includes('diff --git a/src/core.js'));
  assert.ok(patch.includes('diff --git a/tests/core.test.js'));
});

test('diff-paths: a diff without generated files is returned verbatim', () => {
  const source = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b';
  const { patch, omitted } = filterGenerated(source);
  assert.equal(patch, source);
  assert.deepEqual(omitted, []);
});

test('diff-paths: non-patch input is passed through untouched', () => {
  const { patch, omitted } = filterGenerated('diff');
  assert.equal(patch, 'diff');
  assert.deepEqual(omitted, []);
});

test('diff-paths: package.json script edits are not dependency changes', () => {
  const [file] = splitDiff([
    'diff --git a/package.json b/package.json',
    'index 1111111..2222222 100644',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1,3 +1,4 @@',
    '   "scripts": {',
    '+    "check:eol": "node scripts/check-eol.mjs",',
    '     "test": "node --test tests/*.test.js"',
    '   }',
  ].join('\n'));
  assert.equal(touchesDependencies(file!), false);
});

test('diff-paths: dependency and engine edits are dependency changes', () => {
  const [dep] = splitDiff([
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1,2 @@',
    '+    "axios": "^1.7.0",',
  ].join('\n'));
  assert.equal(touchesDependencies(dep!), true);

  const [engines] = splitDiff([
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1,2 @@',
    '+  "engines": { "node": ">=22" },',
  ].join('\n'));
  assert.equal(touchesDependencies(engines!), true);
});

test('diff-paths: lock files always count as dependency changes', () => {
  const [lock] = splitDiff([
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1 +1 @@',
    '-{"lockfileVersion":2}',
    '+{"lockfileVersion":3}',
  ].join('\n'));
  assert.equal(touchesDependencies(lock!), true);
});

test('diff-paths: policy is overridable per project', () => {
  const policy = { ...DEFAULT_POLICY, generated: ['vendor/**'] };
  assert.equal(classifyPath('vendor/lib.js', policy), 'generated');
  assert.equal(classifyPath('dist/bundle.js', policy), 'code');
});

test('diff-paths: quoted paths keep their own block and classify correctly', () => {
  // git emits `diff --git "a/x y" "b/x y"` for paths with spaces, and
  // octal-escaped UTF-8 under core.quotepath — both must not leak into the
  // previous file's block or vanish from classification.
  const patch = [
    'diff --git a/src/core.js b/src/core.js',
    '--- a/src/core.js',
    '+++ b/src/core.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git "a/dist/bundle min.cjs" "b/dist/bundle min.cjs"',
    '--- "a/dist/bundle min.cjs"',
    '+++ "b/dist/bundle min.cjs"',
    '@@ -1 +1 @@',
    '-bundled',
    '+rebundled',
    'diff --git "a/src/\\346\\265\\213\\350\\257\\225.js" "b/src/\\346\\265\\213\\350\\257\\225.js"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/src/\\346\\265\\213\\350\\257\\225.js"',
    '@@ -0,0 +1 @@',
    '+x',
  ].join('\n');
  const files = splitDiff(patch);
  assert.equal(files.length, 3);
  assert.equal(files[1]!.path, 'dist/bundle min.cjs');
  assert.equal(files[1]!.added, 1);
  assert.equal(files[2]!.path, 'src/测试.js');
  assert.equal(files[2]!.status, 'new');
  const { omitted } = filterGenerated(patch);
  assert.deepEqual(omitted, ['dist/bundle min.cjs']);
  // The preceding code file keeps only its own hunk.
  assert.equal(codeStats(files).files, 2);
  assert.equal(codeStats(files).lines, 3);
});
