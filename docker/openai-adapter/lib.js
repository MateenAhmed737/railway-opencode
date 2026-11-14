'use strict';
/*
 * Pure helpers for the OpenAI-compatible adapter: request parsing and address
 * checks. No I/O and no side effects on load, so tests/unit.test.js can require it.
 */
const net = require('node:net');

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * OpenAI message content -> { text, files }.
 * Supports text parts, image parts (`image_url` as object or string, `input_image`)
 * and `file` parts carrying a data: URL (e.g. PDFs). Files are references only;
 * remote URLs are downloaded later by resolveFile().
 */
function contentToParts(content) {
  if (content == null) return { text: '', files: [] };
  if (typeof content === 'string') return { text: content, files: [] };
  if (!Array.isArray(content)) throw badRequest('Unsupported message content');
  let text = '';
  const files = [];
  for (const p of content) {
    if (typeof p === 'string') { text += p; continue; }
    if (!p || typeof p !== 'object') throw badRequest('Invalid content part');
    if (p.type === 'text' || p.type === 'input_text') { text += p.text || ''; continue; }
    if (p.type === 'image_url' || p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url) || p.url;
      if (!url) throw badRequest('image_url part is missing a url');
      files.push({ url, kind: 'image' });
      continue;
    }
    if (p.type === 'file' || p.type === 'input_file') {
      const f = p.file || p;
      const url = f.file_data || f.url;
      if (!url) throw badRequest('file part needs file.file_data (a data: URL); file_id is not supported');
      files.push({ url, kind: 'file', filename: f.filename });
      continue;
    }
    throw badRequest(`Unsupported content part type '${p.type}'. Supported: text, image_url, file.`);
  }
  return { text, files };
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)((?:;[^;,=]+=[^;,]*)*)(;base64)?,/i.exec(url);
  return m ? { mime: m[1].toLowerCase(), base64: !!m[3] } : null;
}

// Addresses a downloaded URL may not resolve to.
const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) BLOCKED.addSubnet(a, p, 'ipv6');
function blockedAddress(address, family) {
  if (family === 6 || family === 'IPv6') {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address); // IPv4-mapped
    return m ? BLOCKED.check(m[1], 'ipv4') : BLOCKED.check(address, 'ipv6');
  }
  return BLOCKED.check(address, 'ipv4');
}

/** OpenAI messages -> { system, text, files } for a single OpenCode prompt. */
function buildPrompt(messages) {
  const system = [];
  const turns = [];
  const files = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw badRequest('Invalid message');
    const { text: body, files: f } = contentToParts(m.content);
    let text = body;
    if (m.role === 'system' || m.role === 'developer') {
      if (f.length) throw badRequest('Images/files are only supported in user messages');
      system.push(text);
      continue;
    }
    if (!['user', 'assistant', 'tool'].includes(m.role)) throw badRequest(`Unsupported role '${m.role}'`);
    if (f.length && m.role !== 'user') throw badRequest('Images/files are only supported in user messages');
    // Mark where attachments sat in the conversation, then attach them all.
    for (const file of f) {
      files.push(file);
      text += `${text ? ' ' : ''}[attachment ${files.length}]`;
    }
    turns.push({ role: m.role, text });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    throw Object.assign(new Error('The last non-system message must have role "user"'), { status: 400 });
  }
  let text;
  if (turns.length === 1) {
    text = turns[0].text;
  } else {
    const label = { user: 'User', assistant: 'Assistant', tool: 'Tool result' };
    const history = turns.slice(0, -1).map((t) => `${label[t.role]}: ${t.text}`).join('\n\n');
    text = `Conversation so far:\n\n${history}\n\nUser: ${turns[turns.length - 1].text}`;
  }
  return { system: system.join('\n\n'), text, files };
}

function parseModel(model) {
  if (model == null || model === '' || model === 'default' || model === 'opencode') return undefined;
  if (typeof model !== 'string') throw badRequest('`model` must be a string like "providerID/modelID" (see GET /v1/models)');
  const i = String(model).indexOf('/');
  if (i <= 0 || i === model.length - 1) {
    throw Object.assign(new Error(`Model must be "providerID/modelID" (see GET /v1/models), got '${model}'`), { status: 400 });
  }
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

function errorMessage(err) {
  if (!err) return 'Unknown error';
  return (err.data && (err.data.message || err.data.responseBody)) || err.message || err.name || JSON.stringify(err);
}

module.exports = { badRequest, contentToParts, parseDataUrl, blockedAddress, buildPrompt, parseModel, errorMessage };
