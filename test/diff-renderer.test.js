'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { renderRow, renderStatusLine } = require('../src/diff-renderer');

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

test('renderRow preserves printable width for all side-by-side row types', () => {
  const width = 50;
  const rows = [
    { type: 'context', leftLineNo: 1, rightLineNo: 1, content: 'same' },
    { type: 'deleted', leftLineNo: 2, content: 'removed' },
    { type: 'added', rightLineNo: 3, content: 'added' },
    { type: 'modified', leftLineNo: 4, rightLineNo: 4, leftContent: 'before', rightContent: 'after' },
  ];

  for (const row of rows) {
    const printable = stripAnsi(renderRow(row, width));
    assert.equal(printable.length, width, row.type);
    assert.equal(printable[Math.floor((width - 1) / 2)], '│', row.type);
  }
});

test('renderStatusLine fits narrow terminal widths', () => {
  const width = 10;
  const printable = stripAnsi(renderStatusLine({
    filePath: 'very-long-name.js',
    stats: { added: 12, removed: 3 },
    scrollOffset: 0,
    rowCount: 20,
    currentHunkIdx: 0,
    totalHunks: 2,
    mode: 'reviewing',
    statusNote: '',
  }, width));

  assert.equal(printable.length, width);
});
