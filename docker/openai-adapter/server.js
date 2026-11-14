'use strict';
/*
 * OpenAI-compatible front door for OpenCode.
 *
 *   public :$PORT â”€â”€â–¶ this process â”€â”€â–¶ opencode web on 127.0.0.1:$OPENCODE_INTERNAL_PORT
 *
 *   GET  /v1/models            -> models from OpenCode's configured providers
 *   POST /v1/chat/completions  -> one OpenCode session + message per request
 *   anything else              -> proxied unchanged (web UI, native API, SSE, websockets)
 *
 * The process also supervises OpenCode: it spawns it, forwards SIGTERM/SIGINT,
 * and exits when OpenCode exits. No npm dependencies.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const env = process.env;
const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);

const PORT = int(env.PORT, 4096);
const UP_PORT = int(env.OPENCODE_INTERNAL_PORT, 4097);
const USER = env.OPENCODE_SERVER_USERNAME || 'opencode';
const PASS = env.OPENCODE_SERVER_PASSWORD || '';
const API_KEY = env.OPENAI_COMPAT_API_KEY || PASS;
const DEFAULT_DIR = env.OPENAI_COMPAT_DIRECTORY || env.WORKSPACE_DIR || '/data/workspace';
// /v1 uses a tool-free "chat" agent by default. With a tool-using agent (e.g. `build`),
// the /v1 key is effectively shell access to the container, including its secrets.
const DEFAULT_AGENT = env.OPENAI_COMPAT_AGENT || 'chat';
// Let callers pick agent/directory with x-opencode-agent / x-opencode-directory headers.
const ALLOW_OVERRIDES = /^(1|true|yes)$/i.test(env.OPENAI_COMPAT_ALLOW_OVERRIDES || '');
const CHAT_AGENT = { mode: 'primary', description: 'Plain chat, no tools', prompt: 'You are a helpful assistant.', permission: { '*': 'deny' } };
const KEEP_SESSIONS = /^(1|true|yes)$/i.test(env.OPENAI_COMPAT_KEEP_SESSIONS || '');
const TIMEOUT_MS = int(env.OPENAI_COMPAT_TIMEOUT_SECONDS, 600) * 1000;
// If OpenCode schedules a provider retry further out than this, fail fast with 429.
const MAX_RETRY_WAIT_MS = int(env.OPENAI_COMPAT_MAX_RETRY_WAIT_SECONDS, 30) * 1000;
// `stream: true` forwards text as OpenCode writes it. Set this to send the whole answer in one chunk at the end instead.
const BUFFER_STREAM = /^(1|true|yes)$/i.test(env.OPENAI_COMPAT_BUFFER_STREAM || '');
// Live streams hold back the HTTP 200 until the first text (or this long), so an early rate limit can still be a real 429.
const STREAM_OPEN_DELAY_MS = 8000;
const MAX_BODY = int(env.OPENAI_COMPAT_MAX_BODY_MB, 25) * 1024 * 1024;
const MAX_REMOTE_FILE = int(env.OPENAI_COMPAT_MAX_IMAGE_MB, 10) * 1024 * 1024;
const FILE_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i;
// http(s) image URLs are downloaded by the adapter. Hosts that resolve to loopback,
// private, link-local or other internal addresses are refused, except hostnames listed in
// OPENAI_COMPAT_IMAGE_HOST_ALLOWLIST (comma-separated; meant for tests on a private Docker network).
const ALLOW_REMOTE_FILES = !/^(0|false|no)$/i.test(env.OPENAI_COMPAT_ALLOW_REMOTE_IMAGES || '');
const PRIVATE_HOST_ALLOWLIST = new Set((env.OPENAI_COMPAT_IMAGE_HOST_ALLOWLIST || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const MAX_REDIRECTS = 3;
const UP_AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

if (!PASS) {
  console.error('[adapter] OPENCODE_SERVER_PASSWORD is required');
  process.exit(1);
}
if (PORT === UP_PORT) {
  console.error(`[adapter] PORT and OPENCODE_INTERNAL_PORT are both ${PORT}; they must differ`);
  process.exit(1);
}

const log = (...a) => console.error('[adapter]', ...a);

// ---------------------------------------------------------------- helpers ---

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Accepts `Authorization: Bearer <key>` (OpenAI SDKs) or the server's Basic auth. */
function authorized(req) {
  const h = req.headers.authorization || '';
  if (/^bearer /i.test(h)) return safeEqual(h.slice(7).trim(), API_KEY);
  if (/^basic /i.test(h)) {
    const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 0) return false;
    return safeEqual(raw.slice(0, i), USER) & safeEqual(raw.slice(i + 1), PASS) ? true : false;
  }
  return false;
}

function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function oaiError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // keep draining so the 413 can be delivered
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        req.resume();
        reject(Object.assign(new Error(`Request body larger than ${MAX_BODY >> 20} MB`), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** JSON call to the internal OpenCode server. No client-side timeout unless a signal is given. */
function oc(method, path, body, signal) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: UP_PORT,
        method,
        path,
        signal,
        headers: {
          authorization: UP_AUTH,
          accept: 'application/json',
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = text ? JSON.parse(text) : null; } catch { json = undefined; }
          resolve({ status: res.statusCode, json, text });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Follow OpenCode's event stream for one session. OpenCode reports provider
 * rate limits as `session.status {type:"retry"}` and keeps waiting (for the
 * free tier, until the quota resets, which can be many hours). Returns a
 * function that stops watching. If the stream fails or drops, it is logged and
 * reopened once; a second loss calls onLost, because without events neither
 * the fast 429 nor live streaming can work.
 */
function watchSession(sessionID, dir, onEvent, onLost) {
  let ready;
  const connected = new Promise((r) => { ready = r; });
  setTimeout(ready, 5000).unref(); // never block a prompt on the watcher for long
  let stopped = false;
  let retried = false;
  let req;
  const lost = (why) => {
    if (stopped) return;
    if (!retried) {
      retried = true;
      log(`event stream for ${sessionID} ${why}; reconnecting`);
      return connect();
    }
    stopped = true;
    log(`event stream for ${sessionID} ${why} again; giving up`);
    ready();
    if (onLost) onLost();
  };
  const connect = () => {
    let gone = false; // report each connection's loss once ('error' and 'end' can both fire)
    const drop = (why) => { if (!gone) { gone = true; lost(why); } };
    req = http.request(
      { host: '127.0.0.1', port: UP_PORT, method: 'GET', path: withDir('/event', dir), headers: { authorization: UP_AUTH, accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return drop(`returned HTTP ${res.statusCode}`); }
        ready();
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const ev = JSON.parse(line.slice(5).trim());
                const p = ev.properties || {};
                if ((p.sessionID || (p.info && p.info.sessionID) || (p.part && p.part.sessionID)) === sessionID) onEvent(ev);
              } catch {}
            }
          }
        });
        res.on('end', () => drop('ended'));
        res.on('error', () => drop('failed'));
      },
    );
    req.on('error', (e) => drop(`failed (${e.code || e.message})`));
    req.end();
  };
  connect();
  const stop = () => { stopped = true; req.destroy(); };
  stop.connected = connected;
  return stop;
}

const withDir = (path, dir) => `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(dir)}`;

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

/** File reference -> OpenCode FilePartInput ({ type, mime, url, filename }). */
async function resolveFile(f, index, signal) {
  const filename = f.filename || `${f.kind}-${index + 1}`;
  if (/^data:/i.test(f.url)) {
    const d = parseDataUrl(f.url);
    if (!d || !d.base64) throw badRequest(`${filename}: data URL must be base64-encoded`);
    if (!FILE_MIME.test(d.mime)) throw badRequest(`${filename}: unsupported type ${d.mime} (png, jpeg, gif, webp or pdf)`);
    return { type: 'file', mime: d.mime === 'image/jpg' ? 'image/jpeg' : d.mime, url: f.url, filename };
  }
  if (!/^https?:\/\//i.test(f.url)) throw badRequest(`${filename}: url must be a data: URL or http(s) URL`);
  if (!ALLOW_REMOTE_FILES) throw badRequest(`${filename}: image URLs are disabled on this server; send the image as a base64 data: URL`);
  try {
    const { mime, buf } = await download(f.url, signal);
    return { type: 'file', mime, url: `data:${mime};base64,${buf.toString('base64')}`, filename };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    // One message for every failure, so responses don't reveal what is on internal hosts.
    log(`image download failed: ${e.message}`);
    throw badRequest(`${filename}: could not download the image URL (it must be a public http(s) URL serving a PNG, JPEG, GIF, WebP or PDF up to ${MAX_REMOTE_FILE >> 20} MB)`);
  }
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

// DNS lookup used for the actual connection, so the address that is checked is the one connected to.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = !PRIVATE_HOST_ALLOWLIST.has(String(hostname).toLowerCase()) && addrs.find((a) => blockedAddress(a.address, a.family));
    if (bad) return cb(Object.assign(new Error(`${hostname} resolves to blocked address ${bad.address}`), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** GET a URL with blocked-address checks on every hop, at most MAX_REDIRECTS redirects, and a streamed size cap. */
async function download(url, signal, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported protocol ${u.protocol}`);
  // Literal IPs never go through the lookup hook, so check them here.
  const ip = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(ip) && !PRIVATE_HOST_ALLOWLIST.has(ip) && blockedAddress(ip, net.isIP(ip))) throw new Error(`blocked address ${ip}`);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(u, { lookup: safeLookup, signal, timeout: 30_000, headers: { accept: 'image/*,application/pdf' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        return resolve(download(new URL(res.headers.location, u).href, signal, hops + 1));
      }
      if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status} from ${u.host}`)); }
      const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!FILE_MIME.test(mime)) { res.resume(); return reject(new Error(`content type '${mime}' from ${u.host}`)); }
      if (Number(res.headers['content-length'] || 0) > MAX_REMOTE_FILE) { res.destroy(); return reject(new Error(`content-length over limit from ${u.host}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REMOTE_FILE) { res.destroy(); req.destroy(); return reject(new Error(`body over ${MAX_REMOTE_FILE} bytes from ${u.host}`)); }
        chunks.push(c);
      });
      res.on('end', () => resolve({ mime: mime === 'image/jpg' ? 'image/jpeg' : mime, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
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

// ---------------------------------------------------------------- routes ----

async function listModels(req, res) {
  const dir = (ALLOW_OVERRIDES && req.headers['x-opencode-directory']) || DEFAULT_DIR;
  const r = await oc('GET', withDir('/config/providers', dir));
  if (r.status !== 200 || !r.json) return oaiError(res, 502, `OpenCode returned ${r.status}`, 'api_error');
  const data = [];
  for (const p of r.json.providers || []) {
    for (const id of Object.keys(p.models || {})) {
      data.push({ id: `${p.id}/${id}`, object: 'model', created: 0, owned_by: p.id });
    }
  }
  sendJson(res, 200, { object: 'list', data });
}

// At most MAX_CONCURRENCY chat requests run at once; others wait up to QUEUE_WAIT_MS, then get a 429.
const MAX_CONCURRENCY = int(env.OPENAI_COMPAT_MAX_CONCURRENCY, 4);
const QUEUE_WAIT_MS = 10_000;
let active = 0;
const waiting = [];
function acquireSlot(res) {
  if (active < MAX_CONCURRENCY) { active++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const entry = { grant: () => { clearTimeout(t); res.off('close', onClose); active++; resolve(true); } };
    const drop = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); };
    const t = setTimeout(() => { drop(); res.off('close', onClose); resolve(false); }, QUEUE_WAIT_MS);
    const onClose = () => { clearTimeout(t); drop(); resolve(null); };
    res.on('close', onClose);
    waiting.push(entry);
  });
}
function releaseSlot() {
  active--;
  const next = waiting.shift();
  if (next) next.grant();
}

async function chatCompletions(req, res) {
  const slot = await acquireSlot(res);
  if (slot === null) return; // client left while queued
  if (!slot) {
    res.setHeader('retry-after', '5');
    return oaiError(res, 429, `Server busy: ${MAX_CONCURRENCY} requests already running. Retry shortly.`, 'rate_limit_error', 'concurrency_limit');
  }
  try {
    return await handleChat(req, res);
  } finally {
    releaseSlot();
  }
}

async function handleChat(req, res) {
  // One abort path for the whole request: client disconnect, timeout or rate limit.
  // Registered first, so a client that leaves during body upload, image download or
  // session creation never gets a model run.
  const ac = new AbortController();
  let timedOut = false;
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableFinished) { clientGone = true; ac.abort(); }
  });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    if (clientGone) return;
    if (e.status === 413) res.setHeader('connection', 'close');
    return oaiError(res, e.status || 400, e.status ? e.message : 'Body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oaiError(res, 400, 'Body must be a JSON object');
  if (!Array.isArray(body.messages) || !body.messages.length) return oaiError(res, 400, '`messages` must be a non-empty array');

  let prompt, model;
  try {
    prompt = buildPrompt(body.messages);
    model = parseModel(body.model);
  } catch (e) {
    return oaiError(res, e.status || 400, e.message);
  }

  // Images/PDFs -> OpenCode file parts (remote URLs downloaded here, before any session exists).
  let fileParts;
  try {
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(60_000)]);
    fileParts = await Promise.all(prompt.files.map((f, i) => resolveFile(f, i, signal)));
  } catch (e) {
    if (clientGone) return log('chat cancelled by client during file download');
    return oaiError(res, e.status || 400, e.status ? e.message : 'Could not download an attached file');
  }
  if (clientGone) return log('chat cancelled by client before start');

  const dir = (ALLOW_OVERRIDES && req.headers['x-opencode-directory']) || DEFAULT_DIR;
  const agent = (ALLOW_OVERRIDES && req.headers['x-opencode-agent']) || DEFAULT_AGENT;
  const stream = body.stream === true;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
  const created = Math.floor(Date.now() / 1000);

  // 1. session
  let s;
  try {
    s = await oc('POST', withDir('/session', dir), { title: `openai-compat ${new Date().toISOString()}` }, AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]));
  } catch (e) {
    if (clientGone) return log('chat cancelled by client during session create');
    return oaiError(res, 502, `Could not create OpenCode session (${e.message})`, 'api_error');
  }
  if (s.status !== 200 || !s.json || !s.json.id) return oaiError(res, 502, `Could not create OpenCode session (${s.status})`, 'api_error');
  const sessionID = s.json.id;
  const started = Date.now();
  if (clientGone) {
    if (!KEEP_SESSIONS) oc('DELETE', withDir(`/session/${sessionID}`, dir)).catch(() => {});
    return log(`chat ${sessionID} cancelled by client before prompt`);
  }
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TIMEOUT_MS);

  // Streaming. The SSE response is opened lazily: on the first live text, or after
  // STREAM_OPEN_DELAY_MS (buffered mode opens at once). Until then errors can still
  // be sent as real HTTP statuses. Once open, keep-alive comments fill silent gaps.
  const live = stream && !BUFFER_STREAM;
  const id = `chatcmpl-${sessionID}`;
  let opened = false;
  let lastWrite = 0;
  let keepalive, openTimer;
  const write = (s) => { lastWrite = Date.now(); res.write(s); };
  const chunk = (delta, finish_reason = null, extra = {}) =>
    write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model || 'default', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
  const open = () => {
    if (opened || clientGone || res.headersSent) return;
    opened = true;
    clearTimeout(openTimer);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-opencode-session': sessionID,
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    chunk({ role: 'assistant', content: '' });
    keepalive = setInterval(() => { if (Date.now() - lastWrite >= 15000) write(': keepalive\n\n'); }, 5000);
  };
  if (stream) {
    if (live) openTimer = setTimeout(open, STREAM_OPEN_DELAY_MS);
    else open();
  }
  // Error reply that fits the current state: an SSE error event once the stream is open, a real HTTP status before.
  const fail = (status, message, type, code = null, headers = {}) => {
    if (opened) {
      write(`data: ${JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } })}\n\ndata: [DONE]\n\n`);
      return res.end();
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return oaiError(res, status, message, type, code);
  };

  // Live text. Assistant text parts are forwarded as `content`, reasoning parts as
  // `reasoning_content`; tool and other parts are skipped. `sent` tracks how much of
  // each part went out, so a full-text update only sends its unsent tail. Text parts
  // are separated by a blank line, matching the non-streamed join below.
  const roles = new Map();   // messageID -> role
  const parts = new Map();   // partID -> { type, messageID }
  const sent = new Map();    // partID -> characters already sent
  let streamedText = false;
  const emit = (partID, type, text) => {
    if (!text || clientGone) return;
    if (type === 'text') {
      const sep = !sent.has(partID) && streamedText ? '\n\n' : '';
      open();
      chunk({ content: sep + text });
      streamedText = true;
    } else {
      open();
      chunk({ reasoning_content: text });
    }
    sent.set(partID, (sent.get(partID) || 0) + text.length);
  };
  const forward = (ev) => {
    const p = ev.properties || {};
    if (ev.type === 'message.updated' && p.info) { roles.set(p.info.id, p.info.role); return; }
    if (ev.type === 'message.part.updated' && p.part) {
      const part = p.part;
      parts.set(part.id, { type: part.type, messageID: part.messageID });
      if (roles.get(part.messageID) !== 'assistant' || part.synthetic || part.ignored) return;
      if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
        emit(part.id, part.type, part.text.slice(sent.get(part.id) || 0));
      }
      return;
    }
    if (ev.type === 'message.part.delta' && p.field === 'text' && typeof p.delta === 'string') {
      const part = parts.get(p.partID);
      if (!part || roles.get(p.messageID) !== 'assistant') return; // unknown part: its part.updated will catch up
      if (part.type === 'text' || part.type === 'reasoning') emit(p.partID, part.type, p.delta);
    }
  };

  // Fail fast instead of hanging when the provider is rate-limiting us.
  let rateLimited = null;
  let watcherLost = false;
  const stopWatching = watchSession(sessionID, dir, (ev) => {
    if (live && !rateLimited) forward(ev);
    if (ev.type !== 'session.status' || !ev.properties.status || ev.properties.status.type !== 'retry') return;
    const st = ev.properties.status;
    const waitMs = typeof st.next === 'number' ? st.next - Date.now() : 0;
    const freeLimit = st.action && st.action.reason === 'free_tier_limit';
    if (!freeLimit && waitMs <= MAX_RETRY_WAIT_MS) return; // short backoff: let OpenCode retry
    const extra = st.action && st.action.message ? ` ${st.action.message}` : '';
    rateLimited = {
      message: `${st.message || 'Provider rate limit'}.${extra}`.replace(/\.\./g, '.'),
      retryAfter: Math.max(1, Math.round(waitMs / 1000)),
      reason: (st.action && st.action.reason) || 'retry',
    };
    ac.abort();
  }, () => { watcherLost = true; ac.abort(); });

  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(openTimer);
    stopWatching();
    if (keepalive) clearInterval(keepalive);
    if (!KEEP_SESSIONS) oc('DELETE', withDir(`/session/${sessionID}`, dir)).catch(() => {});
  };

  // Subscribe before prompting so no early text or retry status is missed.
  await stopWatching.connected;

  // 2. prompt
  let r;
  try {
    r = await oc(
      'POST',
      withDir(`/session/${sessionID}/message`, dir),
      {
        parts: [{ type: 'text', text: prompt.text }, ...fileParts],
        ...(prompt.system ? { system: prompt.system } : {}),
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      },
      ac.signal,
    );
  } catch (e) {
    await oc('POST', withDir(`/session/${sessionID}/abort`, dir)).catch(() => {});
    cleanup();
    if (clientGone) return log(`chat ${sessionID} cancelled by client`);
    if (rateLimited) {
      const when = new Date(Date.now() + rateLimited.retryAfter * 1000).toISOString();
      const msg = `${rateLimited.message} (OpenCode would retry at ${when})`;
      log(`chat ${sessionID} rate limited: ${rateLimited.reason}, retry in ${rateLimited.retryAfter}s`);
      return fail(429, msg, 'rate_limit_error', rateLimited.reason, { 'retry-after': String(rateLimited.retryAfter) });
    }
    const msg = timedOut ? `OpenCode did not finish within ${TIMEOUT_MS / 1000}s (it may be waiting for a permission approval)`
      : watcherLost ? 'Lost the connection to OpenCode\'s event stream, so the request could not be followed'
      : `OpenCode request failed: ${e.message}`;
    log(`chat ${sessionID} failed: ${msg}`);
    return fail(timedOut ? 504 : 502, msg, 'api_error');
  }

  // Usage over every assistant message of the run (one per model call when tools are used),
  // read before the session is deleted.
  let allTokens = null;
  if (r.status === 200) {
    try {
      const m = await oc('GET', withDir(`/session/${sessionID}/message`, dir), undefined, AbortSignal.timeout(5000));
      if (m.status === 200 && Array.isArray(m.json)) allTokens = m.json.filter((x) => x.info && x.info.role === 'assistant').map((x) => x.info.tokens || {});
    } catch {}
  }
  cleanup();

  // Upstream problems are always 502: a 401/4xx from us would read as "your request or key is wrong".
  const info = r.json && r.json.info;
  if (r.status !== 200 || !info) {
    const msg = (r.json && (r.json.message || (r.json.data && r.json.data.message))) || `OpenCode returned ${r.status}`;
    log(`chat ${sessionID} upstream ${r.status}`);
    return fail(502, msg, 'api_error', `upstream_${r.status}`);
  }
  if (info.error && info.error.name !== 'MessageOutputLengthError') {
    const msg = errorMessage(info.error);
    log(`chat ${sessionID} model error: ${info.error.name}`);
    return fail(502, msg, 'api_error', info.error.name);
  }

  const finalText = (r.json.parts || []).filter((p) => p.type === 'text' && !p.synthetic && !p.ignored && p.text);
  const content = finalText.map((p) => p.text).join('\n\n');
  const finish_reason = info.error && info.error.name === 'MessageOutputLengthError' ? 'length' : 'stop';
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  for (const t of allTokens && allTokens.length ? allTokens : [info.tokens || {}]) {
    usage.prompt_tokens += (t.input || 0) + ((t.cache && t.cache.read) || 0);
    usage.completion_tokens += (t.output || 0) + (t.reasoning || 0);
  }
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const modelName = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : body.model || 'default';

  log(`chat ${sessionID} ok model=${modelName} ${Date.now() - started}ms`);

  if (stream) {
    if (live) {
      // Safety net: send any part of the final answer the event stream did not deliver.
      for (const p of finalText) emit(p.id, 'text', p.text.slice(sent.get(p.id) || 0));
      open();
    } else if (content) chunk({ content });
    chunk({}, finish_reason);
    if (includeUsage) write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [], usage })}\n\n`);
    write('data: [DONE]\n\n');
    return res.end();
  }

  sendJson(
    res,
    200,
    {
      id,
      object: 'chat.completion',
      created,
      model: modelName,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
      usage,
    },
    { 'x-opencode-session': sessionID },
  );
}

// ---------------------------------------------------------------- proxy -----

function forwardedHeaders(req) {
  const h = { ...req.headers };
  const ip = req.socket.remoteAddress || '';
  h['x-forwarded-for'] = h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip;
  if (!h['x-forwarded-proto']) h['x-forwarded-proto'] = 'http';
  if (!h['x-forwarded-host'] && h.host) h['x-forwarded-host'] = h.host;
  return h;
}

function proxy(req, res) {
  const up = http.request(
    { host: '127.0.0.1', port: UP_PORT, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (ur) => {
      res.writeHead(ur.statusCode, ur.statusMessage, ur.headers);
      res.flushHeaders();
      ur.pipe(res);
    },
  );
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`OpenCode is not reachable (${e.code || e.message})\n`);
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

function proxyUpgrade(req, socket, head) {
  const up = net.connect(UP_PORT, '127.0.0.1', () => {
    let s = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) s += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(s + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.setNoDelay(true);
  socket.setNoDelay(true);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.on('close', () => socket.destroy());
  socket.on('close', () => up.destroy());
}

// ---------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path !== '/v1' && !path.startsWith('/v1/')) return proxy(req, res);

  // CORS for /v1 so browser clients (e.g. a page opened from disk) can call it.
  // Bearer auth is still required on every real request; preflights carry no credentials.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', 'retry-after');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || 'authorization, content-type',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  if (!authorized(req)) {
    return sendJson(res, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, { 'www-authenticate': 'Bearer' });
  }
  try {
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) return await listModels(req, res);
    if (req.method === 'POST' && path === '/v1/chat/completions') return await chatCompletions(req, res);
    return oaiError(res, 404, `Unknown endpoint ${req.method} ${path}. Supported: GET /v1/models, POST /v1/chat/completions`, 'invalid_request_error', 'unknown_url');
  } catch (e) {
    log('unhandled error:', e && e.message);
    if (!res.headersSent) return oaiError(res, 502, `Adapter error: ${e.message}`, 'api_error');
    res.end();
  }
});
server.on('upgrade', proxyUpgrade);
server.requestTimeout = 0; // chat completions can legitimately run for minutes
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// ---------------------------------------------------------------- supervisor

// Add the tool-free "chat" agent to OpenCode's config. OPENCODE_CONFIG_CONTENT is merged
// on top of the global opencode.json, so the user's own config and agents still apply;
// a "chat" agent defined in an existing OPENCODE_CONFIG_CONTENT wins over ours.
function childEnv() {
  let cfg = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT); } catch {
      log('OPENCODE_CONFIG_CONTENT is not valid JSON; passing it through unchanged (no built-in chat agent)');
      return env;
    }
  }
  cfg.agent = { chat: CHAT_AGENT, ...(cfg.agent || {}) };
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) };
}

const child = spawn('opencode', ['web', '--hostname', '127.0.0.1', '--port', String(UP_PORT), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: childEnv(),
});
child.on('error', (e) => { log('failed to start opencode:', e.message); process.exit(1); });
let stopping = false;
child.on('exit', (code, signal) => {
  log(`opencode exited (${signal || code})`);
  server.close();
  // A stop we asked for (SIGTERM, possibly escalated to SIGKILL) is a clean shutdown.
  if (stopping) process.exit(143);
  process.exit(code == null ? 1 : code);
});

const GRACE_MS = int(env.OPENCODE_SHUTDOWN_GRACE_SECONDS, 8) * 1000;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received, shutting down`);
    server.close();
    child.kill(sig);
    // OpenCode normally exits within a second; occasionally it lingers. Its
    // SQLite store is crash-safe, so escalate rather than wait for the
    // platform to kill the whole container.
    setTimeout(() => {
      log(`opencode still running after ${GRACE_MS / 1000}s, forcing stop`);
      child.kill('SIGKILL');
    }, GRACE_MS).unref();
  });
}

// Open the public port only once OpenCode answers. Requests that reach
// OpenCode while it is still booting can hang forever; until we listen,
// clients get "connection refused" and retry, exactly as without the adapter.
async function waitForOpenCode() {
  const deadline = Date.now() + int(env.OPENCODE_STARTUP_TIMEOUT_SECONDS, 180) * 1000;
  while (!stopping) {
    try {
      const r = await oc('GET', '/global/health', undefined, AbortSignal.timeout(2000));
      if (r.status === 200 && r.json && r.json.healthy) return true;
    } catch {}
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

waitForOpenCode().then((ok) => {
  if (stopping) return;
  if (!ok) {
    log('opencode did not become healthy in time, exiting');
    child.kill('SIGKILL');
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => {
    log(`listening on 0.0.0.0:${PORT}  (OpenAI-compatible /v1 + proxy to OpenCode on 127.0.0.1:${UP_PORT})`);
  });
});
