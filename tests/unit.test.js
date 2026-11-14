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

const { normalizeMessage, fingerprint, splitConversation } = require('../docker/openai-adapter/lib.js');

test('splitConversation splits after the last assistant message', () => {
  const m = [{ role: 'system', content: 's' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  assert.deepEqual(splitConversation(m), { prefix: m.slice(0, 3), tail: m.slice(3) });
  assert.deepEqual(splitConversation(m.slice(0, 2)), { prefix: [], tail: m.slice(0, 2) });
});

test('normalizeMessage: string and text-parts content match, whitespace trimmed', () => {
  assert.deepEqual(normalizeMessage({ role: 'user', content: '  hi there \n' }), ['user', 'hi there']);
  assert.deepEqual(normalizeMessage({ role: 'user', content: [{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }] }), ['user', 'hi there']);
  assert.deepEqual(normalizeMessage({ role: 'assistant', content: null }), ['assistant', '']);
});

test('normalizeMessage: images are identified by a hash, never stored as data', () => {
  const [, v] = normalizeMessage({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
  assert.equal(v[0], 'look');
  assert.match(v[1], /^#[0-9a-f]{64}$/);
});

test('fingerprint: stored reply matches the next request, across content shapes', () => {
  const turn1 = [{ role: 'system', content: 'S' }, { role: 'user', content: 'hello' }];
  const stored = fingerprint('cred', [...turn1, { role: 'assistant', content: 'Hi! ' }]);
  // Next request, sent the way the openai SDK might: array-of-parts, trimmed reply.
  const next = [{ role: 'system', content: 'S' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', content: 'Hi!' }, { role: 'user', content: 'more' }];
  assert.equal(fingerprint('cred', splitConversation(next).prefix), stored);
});

test('fingerprint: edited history, other credential or other system prompt miss', () => {
  const base = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi' }];
  const fp = fingerprint('cred', base);
  assert.notEqual(fingerprint('cred', [{ role: 'user', content: 'hello!' }, base[1]]), fp);
  assert.notEqual(fingerprint('cred', [base[0], { role: 'assistant', content: 'Hello' }]), fp);
  assert.notEqual(fingerprint('other', base), fp);
  assert.notEqual(fingerprint('cred', [{ role: 'system', content: 'S' }, ...base]), fp);
  assert.doesNotMatch(fp, /hello/);
});
