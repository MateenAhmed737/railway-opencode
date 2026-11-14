'use strict';
// Unit tests for the adapter's pure helpers. Run: node --test tests/unit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { contentToParts, parseDataUrl, blockedAddress, buildPrompt, parseModel, errorMessage } = require('../docker/openai-adapter/lib.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('contentToParts: string, null, text parts', () => {
  assert.deepEqual(contentToParts('hi'), { text: 'hi', files: [] });
  assert.deepEqual(contentToParts(null), { text: '', files: [] });
  assert.deepEqual(contentToParts([{ type: 'text', text: 'a' }, 'b', { type: 'input_text', text: 'c' }]), { text: 'abc', files: [] });
});

test('contentToParts: images and files', () => {
  const r = contentToParts([
    { type: 'image_url', image_url: { url: PNG } },
    { type: 'image_url', image_url: 'https://example.com/x.png' },
    { type: 'file', file: { file_data: 'data:application/pdf;base64,AA==', filename: 'x.pdf' } },
  ]);
  assert.deepEqual(r.files.map((f) => f.kind), ['image', 'image', 'file']);
  assert.equal(r.files[2].filename, 'x.pdf');
});

test('contentToParts: rejects unsupported parts with 400', () => {
  for (const bad of [[{ type: 'input_audio' }], [{ type: 'image_url' }], [{ type: 'file', file: { file_id: 'f' } }], { a: 1 }]) {
    assert.throws(() => contentToParts(bad), (e) => e.status === 400);
  }
});

test('parseDataUrl', () => {
  assert.deepEqual(parseDataUrl(PNG), { mime: 'image/png', base64: true });
  assert.deepEqual(parseDataUrl('data:text/plain,hi'), { mime: 'text/plain', base64: false });
  assert.equal(parseDataUrl('https://x'), null);
});

test('buildPrompt: single turn and system', () => {
  assert.deepEqual(buildPrompt([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]), { system: 'S', text: 'U', files: [] });
});

test('buildPrompt: history is flattened into a transcript', () => {
  const r = buildPrompt([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.equal(r.text, 'Conversation so far:\n\nUser: a\n\nAssistant: b\n\nUser: c');
});

test('buildPrompt: marks attachments and rejects bad shapes', () => {
  const r = buildPrompt([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG } }] }]);
  assert.equal(r.text, 'look [attachment 1]');
  assert.equal(r.files.length, 1);
  assert.throws(() => buildPrompt([{ role: 'assistant', content: 'x' }]), (e) => e.status === 400);
  assert.throws(() => buildPrompt([{ role: 'robot', content: 'x' }]), (e) => e.status === 400);
  assert.throws(() => buildPrompt([null]), (e) => e.status === 400);
  assert.throws(() => buildPrompt([{ role: 'system', content: [{ type: 'image_url', image_url: { url: PNG } }] }, { role: 'user', content: 'x' }]), (e) => e.status === 400);
});

test('parseModel', () => {
  assert.equal(parseModel(undefined), undefined);
  assert.equal(parseModel('default'), undefined);
  assert.deepEqual(parseModel('opencode/glm-5.3-flash-free'), { providerID: 'opencode', modelID: 'glm-5.3-flash-free' });
  assert.deepEqual(parseModel('a/b/c'), { providerID: 'a', modelID: 'b/c' });
  for (const bad of [5, {}, 'echo', '/x', 'x/']) assert.throws(() => parseModel(bad), (e) => e.status === 400);
});

test('blockedAddress: internal ranges blocked, public allowed', () => {
  for (const [a, f] of [['127.0.0.1', 4], ['10.1.2.3', 4], ['172.20.0.1', 4], ['192.168.1.1', 4], ['169.254.169.254', 4], ['100.64.0.1', 4], ['0.0.0.0', 4],
    ['::1', 6], ['fe80::1', 6], ['fd00::1', 6], ['::ffff:127.0.0.1', 6], ['::', 6]]) assert.equal(blockedAddress(a, f), true, a);
  for (const [a, f] of [['8.8.8.8', 4], ['1.1.1.1', 4], ['172.32.0.1', 4], ['2606:4700::1111', 6], ['::ffff:8.8.8.8', 6]]) assert.equal(blockedAddress(a, f), false, a);
});

test('errorMessage prefers provider detail', () => {
  assert.equal(errorMessage({ name: 'APIError', data: { message: 'quota' } }), 'quota');
  assert.equal(errorMessage({ name: 'X' }), 'X');
  assert.equal(errorMessage(null), 'Unknown error');
});
