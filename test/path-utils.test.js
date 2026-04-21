'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveWorkspacePath } = require('../src/path-utils');

test('resolveWorkspacePath resolves relative paths against workspace', () => {
  const workspace = path.resolve('tmp-workspace');
  assert.equal(
    resolveWorkspacePath(path.join('src', 'file.js'), workspace),
    path.resolve(workspace, 'src', 'file.js')
  );
});

test('resolveWorkspacePath preserves absolute paths', () => {
  const absolute = path.resolve('other', 'file.js');
  assert.equal(resolveWorkspacePath(absolute, path.resolve('workspace')), absolute);
});
