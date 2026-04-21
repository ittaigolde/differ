'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const WebSocket = require('ws');

const { createServer } = require('../src/server');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessages(ws, count) {
  return new Promise((resolve) => {
    const messages = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === count) resolve(messages);
    });
  });
}

test('openDiff responses are keyed by request id, not tab name', async (t) => {
  const port = await freePort();
  const pending = [];
  const server = createServer({
    port,
    callbacks: {
      onOpenDiff() {
        return new Promise((resolve) => pending.push(resolve));
      },
      onCloseTab() {},
      onOpenFile() {},
      getRecentFiles() { return []; },
    },
  });
  t.after(() => server.cleanup());

  const ws = await connect(port);
  t.after(() => ws.close());
  const messagesPromise = waitForMessages(ws, 2);

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'openDiff',
      arguments: {
        old_file_path: 'same.js',
        new_file_path: 'same.js',
        new_file_contents: 'first',
        tab_name: 'same.js',
      },
    },
  }));

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'openDiff',
      arguments: {
        old_file_path: 'same.js',
        new_file_path: 'same.js',
        new_file_contents: 'second',
        tab_name: 'same.js',
      },
    },
  }));

  while (pending.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  pending[0]({ accepted: true, newContents: 'first' });
  pending[1]({ accepted: true, newContents: 'second' });

  const messages = await messagesPromise;
  assert.deepEqual(messages.map((msg) => msg.id).sort(), [1, 2]);
  assert.equal(messages.find((msg) => msg.id === 1).result.content[1].text, 'first');
  assert.equal(messages.find((msg) => msg.id === 2).result.content[1].text, 'second');
});

test('server reports IDE readiness milestones', async (t) => {
  const port = await freePort();
  const events = [];
  const server = createServer({
    port,
    callbacks: {
      onClientConnected() { events.push('connected'); },
      onInitialize() { events.push('initialize'); },
      onToolsList() { events.push('tools/list'); },
      onOpenDiff() { throw new Error('not used'); },
      onCloseTab() {},
      onOpenFile() {},
      getRecentFiles() { return []; },
    },
  });
  t.after(() => server.cleanup());

  const ws = await connect(port);
  t.after(() => ws.close());
  const messagesPromise = waitForMessages(ws, 3);

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));

  await messagesPromise;
  assert.deepEqual(events, ['connected', 'initialize', 'tools/list']);
});
