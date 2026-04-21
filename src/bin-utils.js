'use strict';

const { execFileSync } = require('child_process');

function resolveBin(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const matches = execFileSync(command, [name], { encoding: 'utf8', env: process.env })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (process.platform === 'win32') {
      const executable = matches.find(match => /\.(cmd|exe|bat)$/i.test(match));
      if (executable) return executable;
    }
    if (matches.length > 0) return matches[0];
  } catch (_) {
    // Fall through to a platform-appropriate executable name.
  }
  if (process.platform === 'win32') return `${name}.cmd`;
  return name;
}

module.exports = { resolveBin };
