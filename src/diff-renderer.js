'use strict';

const path = require('path');

// ANSI helpers
const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const FG_GREEN = '\x1b[32m';
const FG_RED = '\x1b[31m';
const FG_YELLOW = '\x1b[33m';
const FG_GRAY = '\x1b[90m';
const BG_DEL = '\x1b[48;5;52m';   // dark red bg
const BG_ADD = '\x1b[48;5;22m';   // dark green bg
const BG_HDR = '\x1b[48;5;236m';  // dark gray for hunk headers
const DIV = '│';
const EL = '\x1b[K';              // erase to end of line

function truncate(str, maxLen) {
  if (maxLen <= 0) return '';
  const s = str.replace(/\t/g, '  ');
  if (s.length <= maxLen) return s.padEnd(maxLen);
  return s.slice(0, maxLen - 1) + '…';
}

// Build row list from diff hunks (structuredPatch result)
function buildRowList(hunks) {
  const rows = [];
  let hunkIndex = 0;

  for (const hunk of hunks) {
    // Hunk header
    const headerText = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` +
      (hunk.header ? '  ' + hunk.header.trim() : '');
    rows.push({ type: 'hunk-header', text: headerText, hunkIndex });
    hunkIndex++;

    let leftLineNo = hunk.oldStart;
    let rightLineNo = hunk.newStart;

    // Collect consecutive removed/added lines and zip them
    let deletedBuf = [];
    let addedBuf = [];

    function flushBuffers() {
      const len = Math.max(deletedBuf.length, addedBuf.length);
      for (let i = 0; i < len; i++) {
        const d = deletedBuf[i];
        const a = addedBuf[i];
        if (d && a) {
          rows.push({ type: 'modified', leftLineNo: d.n, rightLineNo: a.n, leftContent: d.content, rightContent: a.content });
        } else if (d) {
          rows.push({ type: 'deleted', leftLineNo: d.n, content: d.content });
        } else if (a) {
          rows.push({ type: 'added', rightLineNo: a.n, content: a.content });
        }
      }
      deletedBuf = [];
      addedBuf = [];
    }

    for (const line of hunk.lines) {
      const op = line[0];
      const content = line.slice(1);

      if (op === '-') {
        deletedBuf.push({ n: leftLineNo, content });
        leftLineNo++;
      } else if (op === '+') {
        addedBuf.push({ n: rightLineNo, content });
        rightLineNo++;
      } else {
        // context line — flush pending del/add first
        flushBuffers();
        rows.push({ type: 'context', leftLineNo, rightLineNo, content });
        leftLineNo++;
        rightLineNo++;
      }
    }

    flushBuffers();
  }

  return rows;
}

function countStats(rowList) {
  let added = 0, removed = 0;
  for (const row of rowList) {
    if (row.type === 'added') added++;
    else if (row.type === 'deleted') removed++;
    else if (row.type === 'modified') { added++; removed++; }
  }
  return { added, removed };
}

function hunkOffsets(rowList) {
  return rowList
    .map((r, i) => r.type === 'hunk-header' ? i : -1)
    .filter(i => i >= 0);
}

function nextHunkOffset(rowList, scrollOffset) {
  const offsets = hunkOffsets(rowList);
  const next = offsets.find(i => i > scrollOffset);
  return next !== undefined ? next : scrollOffset;
}

function prevHunkOffset(rowList, scrollOffset) {
  const offsets = hunkOffsets(rowList);
  let prev = scrollOffset;
  for (const i of offsets) {
    if (i < scrollOffset) prev = i;
  }
  return prev;
}

function getCurrentHunkIndex(rowList, scrollOffset) {
  let idx = 0;
  for (let i = 0; i <= scrollOffset && i < rowList.length; i++) {
    if (rowList[i].type === 'hunk-header') idx = rowList[i].hunkIndex;
  }
  return idx;
}

function getTotalHunks(rowList) {
  return rowList.filter(r => r.type === 'hunk-header').length;
}

function renderColumnHeader(width) {
  const halfW = Math.floor((width - 1) / 2);
  const rightW = width - halfW - 1;
  const left = BOLD + DIM + ' original'.padEnd(halfW) + R;
  const right = BOLD + DIM + ' proposed'.padEnd(rightW) + R;
  return left + DIV + right + EL;
}

function renderRow(row, width) {
  const halfW = Math.floor((width - 1) / 2);
  const rightW = width - halfW - 1;
  const lineNumW = 5;
  // 1 space between line number and content
  const contentW = Math.max(0, halfW - lineNumW - 1);

  if (row.type === 'hunk-header') {
    const text = truncate(row.text, width);
    return BG_HDR + FG_YELLOW + text + R + EL;
  }

  if (row.type === 'context') {
    const num = String(row.leftLineNo).padStart(lineNumW);
    const num2 = String(row.rightLineNo).padStart(lineNumW);
    const content = truncate(row.content, contentW);
    const left = DIM + num + ' ' + content + R;
    const right = DIM + num2 + ' ' + truncate(row.content, Math.max(0, rightW - lineNumW - 1)) + R;
    return left.padEnd(halfW) + DIV + right + EL;
  }

  if (row.type === 'deleted') {
    const num = String(row.leftLineNo).padStart(lineNumW);
    const content = truncate(row.content, contentW);
    const left = BG_DEL + '\x1b[37m' + num + R + BG_DEL + ' ' + content + R;
    const right = ' '.repeat(rightW);
    return left + DIV + right + EL;
  }

  if (row.type === 'added') {
    const num = String(row.rightLineNo).padStart(lineNumW);
    const contentW2 = Math.max(0, rightW - lineNumW - 1);
    const content = truncate(row.content, contentW2);
    const left = ' '.repeat(halfW);
    const right = BG_ADD + '\x1b[37m' + num + R + BG_ADD + ' ' + content + R;
    return left + DIV + right + EL;
  }

  if (row.type === 'modified') {
    const lnum = String(row.leftLineNo).padStart(lineNumW);
    const rnum = String(row.rightLineNo).padStart(lineNumW);
    const contentW2 = Math.max(0, rightW - lineNumW - 1);
    const left = BG_DEL + '\x1b[37m' + lnum + R + BG_DEL + ' ' + truncate(row.leftContent, contentW) + R;
    const right = BG_ADD + '\x1b[37m' + rnum + R + BG_ADD + ' ' + truncate(row.rightContent, contentW2) + R;
    return left + DIV + right + EL;
  }

  return '';
}

function renderStatusLine(opts, width) {
  const { filePath, stats, scrollOffset, rowCount, currentHunkIdx, totalHunks, mode, statusNote } = opts;

  if (mode === 'accepted') {
    const msg = ' \u2713 accepted  \u00b7  waiting for next diff\u2026';
    return '\x1b[7m' + FG_GREEN + msg.padEnd(width) + R;
  }
  if (mode === 'rejected') {
    const msg = ' \u2717 rejected  \u00b7  waiting for next diff\u2026';
    return '\x1b[7m' + FG_RED + msg.padEnd(width) + R;
  }

  const fileName = path.basename(filePath);
  const note = statusNote ? ' ' + statusNote : '';
  const statsStr = stats
    ? ` +${stats.added} -${stats.removed}`
    : '';
  const isNewFile = stats && stats.removed === 0 ? ' (new file)' : '';
  const lineStr = `line ${scrollOffset + 1}/${rowCount}`;
  const hunkStr = `hunk ${currentHunkIdx + 1}/${totalHunks}`;
  const hint = `[y] accept  [n] reject`;

  const left = ` ${fileName}${note}${statsStr}${isNewFile}  \u00b7  ${lineStr}  \u00b7  ${hunkStr}`;
  const right = `  ${hint} `;

  const available = width - right.length;
  const leftTrunc = left.length > available ? left.slice(0, available - 1) + '…' : left.padEnd(available);

  return '\x1b[7m' + leftTrunc + right + R;
}

function renderDiffFrame(rowList, scrollOffset, pageHeight, statusLine, width) {
  const parts = ['\x1b[H'];  // cursor home (no clear — avoid flicker)

  // Column header line
  parts.push(renderColumnHeader(width) + '\r\n');

  // Diff rows
  const visibleRows = rowList.slice(scrollOffset, scrollOffset + pageHeight);
  for (const row of visibleRows) {
    parts.push(renderRow(row, width) + '\r\n');
  }

  // Fill empty lines if viewport not full
  for (let i = visibleRows.length; i < pageHeight; i++) {
    parts.push(EL + '\r\n');
  }

  // Status line — no trailing newline to avoid scrolling
  parts.push(statusLine);

  return parts.join('');
}

module.exports = {
  buildRowList,
  countStats,
  hunkOffsets,
  nextHunkOffset,
  prevHunkOffset,
  getCurrentHunkIndex,
  getTotalHunks,
  renderColumnHeader,
  renderRow,
  renderStatusLine,
  renderDiffFrame,
};
