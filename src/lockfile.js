'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getLockDir() {
  return path.join(os.homedir(), '.claude', 'ide');
}

function getLockPath(port) {
  return path.join(getLockDir(), `${port}.lock`);
}

function writeLock(port, workspaceFolders) {
  const dir = getLockDir();
  fs.mkdirSync(dir, { recursive: true });

  const content = JSON.stringify({
    pid: process.pid,
    workspaceFolders,
    ideName: 'differ',
    transport: 'ws',
  });

  fs.writeFileSync(getLockPath(port), content, { encoding: 'utf8' });
}

function deleteLock(port) {
  try {
    fs.unlinkSync(getLockPath(port));
  } catch (_) {}
}

module.exports = { getLockPath, writeLock, deleteLock };
