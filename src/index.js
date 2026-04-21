#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const pty = require('node-pty');
const { structuredPatch } = require('diff');

const { writeLock, deleteLock } = require('./lockfile');
const { createServer } = require('./server');
const { resolveWorkspacePath } = require('./path-utils');
const { resolveBin } = require('./bin-utils');
const { parseWin32InputMode } = require('./win32-input');
const { buildClaudeArgs } = require('./claude-args');
const {
  buildRowList, countStats,
  nextHunkOffset, prevHunkOffset,
  getCurrentHunkIndex, getTotalHunks,
  renderStatusLine, renderDiffFrame,
} = require('./diff-renderer');

// ── ANSI ──────────────────────────────────────────────────────────────────────
const ALT_ON      = '\x1b[?1049h';
const ALT_OFF     = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// ── State ─────────────────────────────────────────────────────────────────────
let state = 'waiting';      // 'waiting' | 'showing-diff' | 'post-accept' | 'post-reject'
let rowList    = [];
let scrollOffset = 0;
let pageHeight   = 0;
let currentDiff  = null;    // { params, resolve, stats, filePath, statusNote }
let diffQueue    = [];
let recentFiles  = [];
let lastChar     = null;    // for ]c / [c sequences
let isShuttingDown = false;
let inAltScreen  = false;
let port         = null;
let wsServer     = null;
let claudeChild  = null;
let workspaceRoot = process.cwd();
let lastKeypressAt = 0;
let lastPtyOutputAt = Date.now();
let lastUserInputAt = Date.now();
let ideClientConnected = false;
let ideInitialized = false;
let ideToolsListed = false;
let ideWarningShown = false;

let termWidth  = process.stdout.columns  || 80;
let termHeight = process.stdout.rows     || 24;

// ── CLI argument parsing ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    workspace: process.cwd(),
    portMin: 10000,
    portMax: 65535,
    debugLog: null,
    inputDebugLog: null,
    claudeArgs: [],
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--workspace' && args[i + 1]) {
      result.workspace = args[++i];
    } else if (args[i] === '--port-min' && args[i + 1]) {
      result.portMin = parseInt(args[++i], 10);
    } else if (args[i] === '--port-max' && args[i + 1]) {
      result.portMax = parseInt(args[++i], 10);
    } else if (args[i] === '--debug') {
      result.debugLog = (args[i + 1] && !args[i + 1].startsWith('-'))
        ? args[++i]
        : '/tmp/differ-debug.log';
    } else if (args[i] === '--input-debug' && args[i + 1]) {
      result.inputDebugLog = args[++i];
    } else if (args[i] === '--resume' && args[i + 1]) {
      result.claudeArgs.push('--resume', args[++i]);
    } else if (args[i] === '--') {
      result.claudeArgs = args.slice(i + 1);
      break;
    } else {
      result.claudeArgs.push(args[i]);
    }
    i++;
  }

  return result;
}

// ── Port discovery ─────────────────────────────────────────────────────────────
function findFreePort(min, max) {
  return new Promise((resolve) => {
    let p = min;
    function tryNext() {
      if (p > max) return resolve(null);
      const s = net.createServer();
      s.listen(p, '127.0.0.1', () => {
        const found = s.address().port;
        s.close(() => resolve(found));
      });
      s.on('error', () => { p++; tryNext(); });
    }
    tryNext();
  });
}

// ── Terminal helpers ───────────────────────────────────────────────────────────
function enterAltScreen() {
  if (inAltScreen) return;
  inAltScreen = true;
  process.stdout.write(ALT_ON + HIDE_CURSOR);
}

function exitAltScreen() {
  if (!inAltScreen) return;
  inAltScreen = false;
  if (process.stdout.isTTY) {
    process.stdout.write(ALT_OFF);
  }
  // Flush any Claude output that arrived while we owned the screen
  for (const chunk of ptyOutputBuffer) process.stdout.write(chunk);
  ptyOutputBuffer = [];
  if (process.stdout.isTTY) {
    process.stdout.write(SHOW_CURSOR);
  }
}

// ── Keypress handling ──────────────────────────────────────────────────────────
let inputDebugStream = null;

function logInputEvent(kind, details) {
  if (!inputDebugStream) return;
  const payload = {
    ts: new Date().toISOString(),
    kind,
    state,
    ...details,
  };
  inputDebugStream.write(JSON.stringify(payload) + '\n');
}

function onStdinKeypress(str, key = {}) {
  lastUserInputAt = Date.now();
  lastKeypressAt = Date.now();
  const sequence = key.sequence || str || '';
  logInputEvent('keypress', {
    str,
    sequence,
    key: { name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift },
  });
  if (state === 'showing-diff') {
    onKeyData(Buffer.from(sequence, 'utf8'), str, key);
  } else {
    // Pass through to Claude's pty
    if (claudeChild && sequence) claudeChild.write(sequence);
  }
}

function onStdinDataFallback(buf) {
  lastUserInputAt = Date.now();
  logInputEvent('data', { bytes: [...buf] });
  if (state === 'showing-diff' && handleWin32InputMode(buf)) return;
  if (state !== 'showing-diff') return;
  if (Date.now() - lastKeypressAt < 25) return;
  onKeyData(buf);
}

function handleWin32InputMode(buf) {
  const parsed = parseWin32InputMode(buf);
  if (!parsed) return false;
  if (parsed.action === 'accept') acceptDiff();
  else if (parsed.action === 'reject') rejectDiff(false);
  else if (parsed.action === 'reject-exit') rejectDiff(true);
  else if (parsed.action === 'scroll-down') scrollDown(1);
  else if (parsed.action === 'scroll-up') scrollUp(1);
  return true;
}

function onKeyData(buf, str = buf.toString('utf8'), key = {}) {
  // Only called when state === 'showing-diff'

  // Two-char vim sequences: ]c and [c
  if (lastChar === ']' && str === 'c') { lastChar = null; jumpNextHunk(); return; }
  if (lastChar === '[' && str === 'c') { lastChar = null; jumpPrevHunk(); return; }
  if (str === ']' || str === '[') { lastChar = str; return; }
  lastChar = null;

  // Arrow keys and escape sequences
  if (key.name === 'up' || str === '\x1b[A' || str === 'k') { scrollUp(1);          return; }
  if (key.name === 'down' || str === '\x1b[B' || str === 'j') { scrollDown(1);        return; }
  if (key.name === 'pageup' || (key.ctrl && key.name === 'b') || str === '\x1b[5~' || buf[0] === 0x02) {
    scrollUp(pageHeight);
    return;
  }
  if (key.name === 'pagedown' || (key.ctrl && key.name === 'f') || str === '\x1b[6~' || buf[0] === 0x06) {
    scrollDown(pageHeight);
    return;
  }

  // Single-key commands. Some terminals can deliver printable keys with extra
  // bytes in the same chunk, so key off the first character instead of requiring
  // an exact one-byte buffer.
  const b = buf[0];
  const firstChar = str[0] || '';
  if (firstChar === 'y' || firstChar === 'Y') { acceptDiff();       return; }
  if (firstChar === 'n' || firstChar === 'N') { rejectDiff(false);  return; }
  if (key.name === 'escape' || (b === 0x1B && buf.length === 1)) { rejectDiff(false); return; }
  if ((key.ctrl && key.name === 'c') || b === 0x03) { rejectDiff(true);   return; }
}

function scrollUp(n) {
  scrollOffset = Math.max(0, scrollOffset - n);
  draw();
}

function scrollDown(n) {
  const max = Math.max(0, rowList.length - pageHeight);
  scrollOffset = Math.min(max, scrollOffset + n);
  draw();
}

function jumpNextHunk() {
  scrollOffset = nextHunkOffset(rowList, scrollOffset);
  draw();
}

function jumpPrevHunk() {
  scrollOffset = prevHunkOffset(rowList, scrollOffset);
  draw();
}

// ── Diff lifecycle ─────────────────────────────────────────────────────────────
function showDiff(item) {
  const { params } = item;
  const sourcePath = params.old_file_path || params.new_file_path || params.tab_name || 'unknown';
  const filePath = resolveWorkspacePath(sourcePath, workspaceRoot);

  if (!recentFiles.includes(filePath)) {
    recentFiles.unshift(filePath);
    recentFiles = recentFiles.slice(0, 20);
  }

  let oldContent = '';
  let statusNote = '';
  try {
    oldContent = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') statusNote = '(unreadable)';
  }

  // Normalize line endings
  const newContent = (params.new_file_contents || '').replace(/\r\n/g, '\n');
  const oldNorm    = oldContent.replace(/\r\n/g, '\n');

  const patch = structuredPatch(filePath, filePath, oldNorm, newContent, '', '', { context: 3 });

  rowList = buildRowList(patch.hunks);
  scrollOffset = 0;
  pageHeight   = termHeight - 3;
  state = 'showing-diff';
  lastChar = null;

  const stats = countStats(rowList);
  currentDiff = { params, resolve: item.resolve, stats, filePath, sourcePath, statusNote };

  enterAltScreen();
  draw();
}

function acceptDiff() {
  const { resolve, params } = currentDiff;
  state = 'post-accept';
  draw();
  resolve({ accepted: true, newContents: params.new_file_contents || '' });
  currentDiff = null;
  setTimeout(nextDiffOrWait, 0);
}

function rejectDiff(shouldExit) {
  const { resolve, params } = currentDiff;
  state = 'post-reject';
  draw();
  resolve({ accepted: false, newContents: params.new_file_contents || '' });
  currentDiff = null;
  if (shouldExit) {
    setTimeout(() => startCleanup(0), 0);
  } else {
    setTimeout(nextDiffOrWait, 0);
  }
}

function nextDiffOrWait() {
  exitAltScreen();  // also flushes ptyOutputBuffer
  if (diffQueue.length > 0) {
    showDiff(diffQueue.shift());
  } else {
    state = 'waiting';
    rowList = [];
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function draw() {
  if (state === 'waiting') return; // Claude's pty output shows through

  const { stats, filePath, statusNote } = currentDiff || {};
  const currentHunkIdx = getCurrentHunkIndex(rowList, scrollOffset);
  const totalHunks     = getTotalHunks(rowList);

  let mode = 'reviewing';
  if (state === 'post-accept') mode = 'accepted';
  if (state === 'post-reject') mode = 'rejected';

  const statusLine = renderStatusLine({
    filePath: filePath || '',
    stats,
    scrollOffset,
    rowCount: rowList.length,
    currentHunkIdx,
    totalHunks,
    mode,
    statusNote,
  }, termWidth);

  const frame = renderDiffFrame(rowList, scrollOffset, pageHeight, statusLine, termWidth);
  process.stdout.write(HIDE_CURSOR + frame);
}

function writeWhenTerminalIdle(message, idleMs = 500) {
  const tryWrite = () => {
    const now = Date.now();
    const outputIdle = now - lastPtyOutputAt >= idleMs;
    const inputIdle = now - lastUserInputAt >= idleMs;
    if (ideToolsListed || isShuttingDown) return;
    if (outputIdle && inputIdle && !inAltScreen) {
      process.stderr.write(`\r\n${message}\r\n`);
      return;
    }
    setTimeout(tryWrite, idleMs);
  };
  setTimeout(tryWrite, idleMs);
}

function scheduleIdeReadinessWarning(delayMs = 3500) {
  setTimeout(() => {
    if (ideToolsListed || ideWarningShown || isShuttingDown) return;
    ideWarningShown = true;

    const status = ideInitialized
      ? 'connected, but has not listed IDE tools'
      : ideClientConnected
        ? 'connected, but has not initialized IDE mode'
        : 'not connected to IDE mode';

    writeWhenTerminalIdle(
      `[differ] Claude has ${status}; diff review may not be active.\r\n` +
      '[differ] In Claude, run /ide and select differ. For logs, run with --debug ./ws.log.'
    );
  }, delayMs);
}

// ── Resize ─────────────────────────────────────────────────────────────────────
process.stdout.on('resize', () => {
  termWidth  = process.stdout.columns || 80;
  termHeight = process.stdout.rows    || 24;
  pageHeight = termHeight - 3;
  scrollOffset = Math.min(scrollOffset, Math.max(0, rowList.length - pageHeight));
  if (claudeChild) {
    try { claudeChild.resize(termWidth, termHeight); } catch (_) {}
  }
  draw();
});

// ── Startup ────────────────────────────────────────────────────────────────────
async function main() {
  const cliArgs = parseArgs(process.argv);
  const workspacePath = path.resolve(cliArgs.workspace);
  workspaceRoot = workspacePath;
  if (cliArgs.inputDebugLog) {
    inputDebugStream = fs.createWriteStream(cliArgs.inputDebugLog, { flags: 'a' });
  }

  // 1. Find free port
  port = await findFreePort(cliArgs.portMin, cliArgs.portMax);
  if (!port) {
    process.stderr.write('Error: no free port found in range ' +
      `${cliArgs.portMin}–${cliArgs.portMax}\n`);
    process.exit(1);
  }

  // 2. Write lock file
  try {
    writeLock(port, [workspacePath]);
  } catch (e) {
    process.stderr.write(`Error writing lock file: ${e.message}\n`);
    process.exit(1);
  }

  // 3. Register cleanup handlers
  process.on('exit', syncCleanup);
  process.on('SIGTERM', () => startCleanup(0));
  process.on('uncaughtException', (e) => {
    process.stderr.write(`Uncaught exception: ${e.stack}\n`);
    startCleanup(1);
  });
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`Unhandled rejection: ${e}\n`);
    startCleanup(1);
  });

  // 4. Start WebSocket server
  const callbacks = {
    onOpenDiff(params) {
      return new Promise((resolve) => {
        const item = { params, resolve };
        if (currentDiff === null) {
          showDiff(item);
        } else {
          diffQueue.push(item);
        }
      });
    },
    onClientConnected() {
      ideClientConnected = true;
    },
    onInitialize() {
      ideInitialized = true;
    },
    onToolsList() {
      ideToolsListed = true;
    },
    onCloseTab(tabName) {
      // If the closed tab matches our current diff, clear it
      const resolvedTabName = resolveWorkspacePath(tabName, workspaceRoot);
      if (currentDiff && (
        currentDiff.filePath === resolvedTabName ||
        currentDiff.sourcePath === tabName ||
        currentDiff.params.tab_name === tabName
      )) {
        currentDiff = null;
        setTimeout(nextDiffOrWait, 0);
      }
    },
    onOpenFile({ path: filePath }) {
      if (filePath && !recentFiles.includes(filePath)) {
        recentFiles.unshift(filePath);
        recentFiles = recentFiles.slice(0, 20);
      }
    },
    getRecentFiles() { return recentFiles.slice(); },
  };

  wsServer = createServer({ port, callbacks, debugLog: cliArgs.debugLog });

  // 5. Own stdin — set raw mode once, route based on state
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onStdinKeypress);
    process.stdin.on('data', onStdinDataFallback);
  }

  // 6. Spawn claude in a pty (gets its own TTY, no stdin competition)
  pageHeight = termHeight - 3;
  spawnClaude(workspacePath, cliArgs.claudeArgs);
  scheduleIdeReadinessWarning();
}

// Pty output buffered while diff screen is active, flushed on return
let ptyOutputBuffer = [];

function spawnClaude(workspacePath, extraArgs) {
  const claudeBin = resolveBin('claude');
  const claudeArgs = buildClaudeArgs(extraArgs);
  try {
    claudeChild = pty.spawn(claudeBin, claudeArgs, {
      name: 'xterm-256color',
      cols: termWidth,
      rows: termHeight,
      cwd: workspacePath,
      env: { ...process.env },
    });
  } catch (err) {
    if (err.code === 'ENOENT' || /not found|posix_spawnp/i.test(err.message)) {
      process.stderr.write(
        'Error: claude not found.\n' +
        `Tried: ${claudeBin}\n` +
        'Install with: npm install -g @anthropic-ai/claude-code\n'
      );
    } else {
      process.stderr.write(`Failed to spawn claude: ${err.message}\n`);
    }
    startCleanup(1);
    return;
  }

  claudeChild.onData((data) => {
    lastPtyOutputAt = Date.now();
    if (inAltScreen) {
      // Diff screen is active — buffer Claude's output for later
      ptyOutputBuffer.push(data);
    } else {
      process.stdout.write(data);
    }
  });

  claudeChild.onExit(({ exitCode }) => {
    startCleanup(exitCode ?? 1);
  });
}

// ── Shutdown ───────────────────────────────────────────────────────────────────
function startCleanup(exitCode) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Reject any pending diff
  if (currentDiff) {
    try {
      currentDiff.resolve({ accepted: false, newContents: currentDiff.params.new_file_contents || '' });
    } catch (_) {}
    currentDiff = null;
  }

  // Reject queued diffs
  for (const item of diffQueue) {
    try { item.resolve({ accepted: false, newContents: '' }); } catch (_) {}
  }
  diffQueue = [];

  exitAltScreen();

  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch (_) {}
  }

  if (wsServer) { try { wsServer.cleanup(); } catch (_) {} }
  if (inputDebugStream) {
    try { inputDebugStream.end(); } catch (_) {}
    inputDebugStream = null;
  }

  if (claudeChild) {
    try { claudeChild.kill(); } catch (_) {}
  }

  deleteLock(port);

  process.exit(exitCode);
}

function syncCleanup() {
  try { deleteLock(port); } catch (_) {}
  try { if (claudeChild) claudeChild.kill(); } catch (_) {}
}

main().catch((e) => {
  process.stderr.write(`Startup error: ${e.stack}\n`);
  process.exit(1);
});
