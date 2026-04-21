'use strict';

const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  process.exit(0);
}

const helperPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
  'darwin-arm64',
  'spawn-helper'
);

try {
  if (fs.existsSync(helperPath)) {
    fs.chmodSync(helperPath, 0o755);
  }
} catch (_) {
  // Best-effort compatibility fix; installation should not fail if chmod does.
}
