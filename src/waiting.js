'use strict';

const MESSAGES = [
  'twiddling my thumbs...',
  'staring into the void...',
  'contemplating your codebase...',
  'waiting for claude to do something reckless...',
  'on standby...',
  'claude is thinking. or not. hard to tell.',
  'your terminal is very clean right now.',
];

function renderWaiting(width, height, msgIndex) {
  const msg = MESSAGES[msgIndex % MESSAGES.length];
  const topPad = Math.floor((height - 1) / 2);
  const lines = [];

  for (let i = 0; i < height; i++) {
    if (i === topPad) {
      const leftPad = Math.max(0, Math.floor((width - msg.length) / 2));
      lines.push(' '.repeat(leftPad) + msg);
    } else {
      lines.push('');
    }
  }

  return '\x1b[2J\x1b[H' + lines.join('\r\n');
}

module.exports = { renderWaiting };
