import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubRedirectTarget } from '../src/ui/server.js';
import { githubLink } from '../ui/src/api.js';

test('the same-origin redirector only accepts GitHub repo/issue/pull URLs', () => {
  assert.equal(githubRedirectTarget('https://github.com/o/r/issues/12'), 'https://github.com/o/r/issues/12');
  assert.equal(githubRedirectTarget('https://github.com/o/r/pull/44'), 'https://github.com/o/r/pull/44');
  assert.equal(githubRedirectTarget('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(githubRedirectTarget('https://www.github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(githubRedirectTarget('http://github.com/o/r/issues/1'), null);
  assert.equal(githubRedirectTarget('https://evil.example/o/r/issues/1'), null);
  assert.equal(githubRedirectTarget('https://github.com/o/r/settings'), null);
  assert.equal(githubRedirectTarget('https://github.com/o/r/pull/abc'), null);
  assert.equal(githubRedirectTarget('javascript:alert(1)'), null);
  assert.equal(githubRedirectTarget('not a url'), null);
});

test('githubLink keeps the original URL inside the same-origin query', () => {
  assert.equal(
    githubLink('https://github.com/o/r/issues/1'),
    '/api/open?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fissues%2F1',
  );
  assert.equal(githubLink(null), '#');
});
