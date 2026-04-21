'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseWin32InputMode } = require('../src/win32-input');

function record(virtualKeyCode, charCode, isKeyDown = 1) {
  return Buffer.from(`\x1b[${virtualKeyCode};1;${charCode};${isKeyDown};0;1_`);
}

test('parseWin32InputMode maps printable review commands', () => {
  assert.deepEqual(parseWin32InputMode(record(89, 121)), { action: 'accept' });
  assert.deepEqual(parseWin32InputMode(record(89, 89)), { action: 'accept' });
  assert.deepEqual(parseWin32InputMode(record(78, 110)), { action: 'reject' });
  assert.deepEqual(parseWin32InputMode(record(78, 78)), { action: 'reject' });
});

test('parseWin32InputMode maps escape and ctrl-c', () => {
  assert.deepEqual(parseWin32InputMode(record(27, 0)), { action: 'reject' });
  assert.deepEqual(parseWin32InputMode(record(67, 3)), { action: 'reject-exit' });
});

test('parseWin32InputMode maps scrolling keys', () => {
  assert.deepEqual(parseWin32InputMode(record(74, 106)), { action: 'scroll-down' });
  assert.deepEqual(parseWin32InputMode(record(75, 107)), { action: 'scroll-up' });
  assert.deepEqual(parseWin32InputMode(record(40, 0)), { action: 'scroll-down' });
  assert.deepEqual(parseWin32InputMode(record(38, 0)), { action: 'scroll-up' });
});

test('parseWin32InputMode ignores key-up and non-matching input', () => {
  assert.deepEqual(parseWin32InputMode(record(89, 121, 0)), { action: 'ignore' });
  assert.equal(parseWin32InputMode(Buffer.from('y')), null);
});
