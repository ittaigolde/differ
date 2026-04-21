'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildClaudeArgs } = require('../src/claude-args');

test('buildClaudeArgs enables IDE auto-connect by default', () => {
  assert.deepEqual(buildClaudeArgs([]), ['--ide']);
  assert.deepEqual(buildClaudeArgs(['--resume', 'abc']), ['--ide', '--resume', 'abc']);
});

test('buildClaudeArgs does not duplicate explicit --ide', () => {
  assert.deepEqual(buildClaudeArgs(['--ide', '--model', 'x']), ['--ide', '--model', 'x']);
});
