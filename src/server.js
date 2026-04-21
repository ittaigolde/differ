'use strict';

const { WebSocketServer } = require('ws');
const fs = require('fs');

const TOOLS = [
  {
    name: 'openDiff',
    description: 'Open a diff view comparing old and new file contents',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path:     { type: 'string' },
        new_file_path:     { type: 'string' },
        new_file_contents: { type: 'string' },
        tab_name:          { type: 'string' },
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
    },
  },
  {
    name: 'getOpenEditors',
    description: 'Get recently opened files',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getCurrentSelection',
    description: 'Get current editor selection',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openFile',
    description: 'Open a file',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all diff tabs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getDiagnostics',
    description: 'Get diagnostics for a file or workspace',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
    },
  },
];

function createServer({ port, callbacks, debugLog }) {
  let logStream = null;
  if (debugLog) {
    logStream = fs.createWriteStream(debugLog, { flags: 'a' });
  }

  function log(dir, raw) {
    if (!logStream) return;
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] ${dir}: ${raw}\n`);
  }

  const wss = new WebSocketServer({ host: '127.0.0.1', port });

  // Pending deferred responses: "toolName-uniqueKey" → { id, ws }
  const deferredMap = new Map();

  function send(ws, obj) {
    const raw = JSON.stringify(obj);
    log('OUT', raw);
    try { ws.send(raw); } catch (_) {}
  }

  function toolResult(id, content) {
    return { jsonrpc: '2.0', id, result: { content } };
  }

  function textContent(text) {
    return [{ type: 'text', text }];
  }

  wss.on('connection', (ws) => {
    callbacks.onClientConnected && callbacks.onClientConnected();

    ws.on('message', (data) => {
      const raw = data.toString();
      log('IN', raw);

      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      const { method, id, params } = msg;

      if (method === 'initialize') {
        callbacks.onInitialize && callbacks.onInitialize();
        send(ws, {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'differ', version: '0.1.0' },
            capabilities: { tools: {} },
          },
        });
        // Send initialized notification
        send(ws, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        return;
      }

      if (method === 'tools/list') {
        callbacks.onToolsList && callbacks.onToolsList();
        send(ws, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      }

      if (method === 'ping') {
        send(ws, { jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        handleToolCall(ws, id, name, args || {});
        return;
      }

      // Ignore notifications (no id) and unknown methods
    });
  });

  function handleToolCall(ws, id, name, args) {
    switch (name) {
      case 'openDiff': {
        const tabName = args.tab_name || args.old_file_path || 'unknown';
        const deferKey = id;

        // Store by JSON-RPC id, not tab name; multiple diffs can target one file.
        deferredMap.set(deferKey, { id, ws, tabName });

        // Kick off the async diff UI
        callbacks.onOpenDiff(args).then(({ accepted, newContents }) => {
          const stored = deferredMap.get(deferKey);
          if (!stored) return;
          deferredMap.delete(deferKey);

          if (accepted) {
            send(stored.ws, toolResult(stored.id, [
              { type: 'text', text: 'FILE_SAVED' },
              { type: 'text', text: newContents },
            ]));
          } else {
            send(stored.ws, toolResult(stored.id, [
              { type: 'text', text: 'DIFF_REJECTED' },
              { type: 'text', text: stored.tabName },
            ]));
          }
        }).catch(() => {
          const stored = deferredMap.get(deferKey);
          if (!stored) return;
          deferredMap.delete(deferKey);
          send(stored.ws, toolResult(stored.id, [
            { type: 'text', text: 'DIFF_REJECTED' },
            { type: 'text', text: stored.tabName },
          ]));
        });
        break;
      }

      case 'getOpenEditors': {
        const files = callbacks.getRecentFiles().map(p => ({ path: p, isActive: false }));
        send(ws, toolResult(id, textContent(JSON.stringify(files))));
        break;
      }

      case 'getCurrentSelection': {
        send(ws, toolResult(id, textContent('null')));
        break;
      }

      case 'openFile': {
        const filePath = args.filePath || args.path || args.file_path || '';
        if (filePath) callbacks.onOpenFile({ path: filePath });
        send(ws, toolResult(id, textContent('"ok"')));
        break;
      }

      case 'close_tab': {
        // If this tab has a pending openDiff, treat close as rejection
        const closedTab = args.tab_name || '';
        const closeEntries = [...deferredMap.entries()]
          .filter(([, stored]) => stored.tabName === closedTab);
        for (const [closeKey, stored] of closeEntries) {
          deferredMap.delete(closeKey);
          send(stored.ws, toolResult(stored.id, [
            { type: 'text', text: 'DIFF_REJECTED' },
            { type: 'text', text: closedTab },
          ]));
        }
        if (closeEntries.length > 0) callbacks.onCloseTab && callbacks.onCloseTab(closedTab);
        send(ws, toolResult(id, textContent('"ok"')));
        break;
      }

      case 'closeAllDiffTabs': {
        send(ws, toolResult(id, textContent('"ok"')));
        break;
      }

      case 'getDiagnostics': {
        send(ws, toolResult(id, textContent('[]')));
        break;
      }

      default: {
        send(ws, {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
      }
    }
  }

  function cleanup() {
    for (const { id, ws } of deferredMap.values()) {
      try {
        send(ws, toolResult(id, [
          { type: 'text', text: 'DIFF_REJECTED' },
          { type: 'text', text: 'shutdown' },
        ]));
      } catch (_) {}
    }
    deferredMap.clear();

    wss.clients.forEach(ws => { try { ws.close(); } catch (_) {} });
    wss.close();

    if (logStream) {
      try { logStream.end(); } catch (_) {}
      logStream = null;
    }
  }

  return { cleanup };
}

module.exports = { createServer };
