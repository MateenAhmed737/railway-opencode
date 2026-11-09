'use strict';
// Minimal OpenAI-compatible model server used only by tests/adapter-test.sh.
// Replies "FAKE-REPLY[sys=<yes|no>]: <last user text>" so tests can check what
// OpenCode actually sent upstream. "SLOW" in the prompt delays the reply by 8s
// to exercise the adapter timeout. Supports stream and non-stream requests.
const http = require('node:http');

const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));

function respond(res, body, reply) {
  if (res.destroyed) return;
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  if (body.stream) {
    const base = { id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'echo' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 0, model: 'echo', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo', object: 'model' }] }));
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const msgs = body.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const sys = msgs.some((m) => m.role === 'system' && text(m).includes('ADAPTER-SYSTEM-MARKER')) ? 'yes' : 'no';
      const reply = `FAKE-REPLY[sys=${sys}]: ${lastUser ? text(lastUser).slice(-200) : ''}`;
      setTimeout(() => respond(res, body, reply), reply.includes('SLOW') ? 8000 : 0);
    });
  })
  .listen(9000, '0.0.0.0', () => console.log('fake llm on :9000'));
