'use strict';

function parseWin32InputMode(buf) {
  const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const match = raw.match(/^\x1b\[(\d+);\d+;(\d+);(\d+);\d+;\d+_$/);
  if (!match) return null;

  const virtualKeyCode = Number(match[1]);
  const charCode = Number(match[2]);
  const isKeyDown = match[3] === '1';
  if (!isKeyDown) return { action: 'ignore' };

  if (charCode === 121 || charCode === 89) return { action: 'accept' };
  if (charCode === 110 || charCode === 78) return { action: 'reject' };
  if (charCode === 27 || virtualKeyCode === 27) return { action: 'reject' };
  if (charCode === 3) return { action: 'reject-exit' };
  if (charCode === 106 || virtualKeyCode === 40) return { action: 'scroll-down' };
  if (charCode === 107 || virtualKeyCode === 38) return { action: 'scroll-up' };

  return { action: 'ignore' };
}

module.exports = { parseWin32InputMode };
