'use strict';

function buildClaudeArgs(extraArgs) {
  if (extraArgs.includes('--ide')) return extraArgs;
  return ['--ide', ...extraArgs];
}

module.exports = { buildClaudeArgs };
