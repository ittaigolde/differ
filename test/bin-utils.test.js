'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveBin } = require('../src/bin-utils');

test('resolveBin finds node executable', () => {
  const resolved = resolveBin('node');
  assert.match(resolved, process.platform === 'win32' ? /node(\.exe)?$/i : /node$/);
});
