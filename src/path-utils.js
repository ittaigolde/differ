'use strict';

const path = require('path');

function resolveWorkspacePath(filePath, workspacePath) {
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspacePath || process.cwd(), filePath);
}

module.exports = { resolveWorkspacePath };
