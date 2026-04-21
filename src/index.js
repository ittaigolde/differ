#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const pty = require('node-pty');
const { structuredPatch } = require('diff');

const { writeLock, deleteLock } = require('./lockfile');
const { createServer } = require('./server');
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
let msgIndex     = 0;
let recentFiles  = [];
let lastChar     = null;    // for ]c / [c sequences
let isShuttingDown = false;
let inAltScreen  = false;
let port         = null;
let wsServer     = null;
let claudeChild  = null;

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
        : '/tmp/claude-diff-tui-debug.log';
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
    process.stdout.write(SHOW_CURSOR + ALT_OFF);
  }
  // Flush any Claude output that arrived while we owned the screen
  for (const chunk of ptyOutputBuffer) process.stdout.write(chunk);
  ptyOutputBuffer = [];
}

// Raw mode is set once at startup. enableRawMode/disableRawMode are no-ops
// kept so call sites compile; stdin routing happens in the single data handler.
function enableRawMode() {}
function disableRawMode() {}

// ── Keypress handling ──────────────────────────────────────────────────────────
function onStdinData(buf) {
  if (state === 'showing-diff') {
    onKeyData(buf);
  } else {
    // Pass through to Claude's pty
    if (claudeChild) claudeChild.write(buf.toString('binary'));
  }
}

function onKeyData(buf) {
  // Only called when state === 'showing-diff'

  const str = buf.toString('utf8');

  // Two-char vim sequences: ]c and [c
  if (lastChar === ']' && str === 'c') { lastChar = null; jumpNextHunk(); return; }
  if (lastChar === '[' && str === 'c') { lastChar = null; jumpPrevHunk(); return; }
  if (str === ']' || str === '[') { lastChar = str; return; }
  lastChar = null;

  // Arrow keys and escape sequences
  if (str === '\x1b[A' || str === 'k') { scrollUp(1);          return; }
  if (str === '\x1b[B' || str === 'j') { scrollDown(1);        return; }
  if (str === '\x1b[5~' || buf[0] === 0x02) { scrollUp(pageHeight);   return; } // PgUp / Ctrl+B
  if (str === '\x1b[6~' || buf[0] === 0x06) { scrollDown(pageHeight); return; } // PgDn / Ctrl+F

  // Single byte keys
  const b = buf[0];
  if (b === 0x79) { acceptDiff();       return; }  // y
  if (b === 0x6E) { rejectDiff(false);  return; }  // n
  if (b === 0x1B && buf.length === 1) { rejectDiff(false); return; }  // Esc
  if (b === 0x03) { rejectDiff(true);   return; }  // Ctrl+C
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
  const filePath = params.old_file_path || params.tab_name || 'unknown';

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
  currentDiff = { params, resolve: item.resolve, stats, filePath, statusNote };

  enterAltScreen();
  enableRawMode();
  draw();
}

function acceptDiff() {
  const { resolve, params } = currentDiff;
  state = 'post-accept';
  draw();
  disableRawMode();
  resolve({ accepted: true, newContents: params.new_file_contents || '' });
  currentDiff = null;
  setTimeout(nextDiffOrWait, 800);
}

function rejectDiff(shouldExit) {
  const { resolve, params } = currentDiff;
  state = 'post-reject';
  draw();
  disableRawMode();
  resolve({ accepted: false, newContents: params.new_file_contents || '' });
  currentDiff = null;
  if (shouldExit) {
    setTimeout(() => startCleanup(0), 400);
  } else {
    setTimeout(nextDiffOrWait, 800);
  }
}

function nextDiffOrWait() {
  exitAltScreen();  // also flushes ptyOutputBuffer
  msgIndex++;
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
  process.stdout.write('\x1b[?25l' + frame + '\x1b[?25h');
}

function drawWaiting() {
  process.stdout.write(renderWaiting(termWidth, termHeight, msgIndex));
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
    onCloseTab(tabName) {
      // If the closed tab matches our current diff, clear it
      if (currentDiff && (currentDiff.filePath === tabName || currentDiff.params.tab_name === tabName)) {
        disableRawMode();
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
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onStdinData);
  }

  // 6. Spawn claude in a pty (gets its own TTY, no stdin competition)
  pageHeight = termHeight - 3;
  spawnClaude(workspacePath, cliArgs.claudeArgs);
}

// Pty output buffered while diff screen is active, flushed on return
let ptyOutputBuffer = [];

function resolveBin(name) {
  const { execSync } = require('child_process');
  try {
    return execSync(`which ${name}`, { encoding: 'utf8', env: process.env }).trim();
  } catch (_) {
    return name;
  }
}

function spawnClaude(workspacePath, extraArgs) {
  const claudeBin = resolveBin('claude');
  try {
    claudeChild = pty.spawn(claudeBin, extraArgs, {
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
