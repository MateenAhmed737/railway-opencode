'use strict';
// Minimal OpenAI-compatible model server used only by tests/adapter-test.sh.
// Replies "FAKE-REPLY[sys=<yes|no>]: <last user text>" so tests can check what
// OpenCode actually sent upstream. "SLOW" in the prompt delays the reply by 8s
// to exercise the adapter timeout. Supports stream and non-stream requests.
const http = require('node:http');

const text = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));
const images = (m) => (Array.isArray(m && m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0);
// 1x1 PNG served at /test.png so the adapter's remote-image download can be tested.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

// Every chat request is recorded (tool count, agent prompt size) and served at /requests.
const seen = [];
// Chat requests currently open, and the most ever open at once (served at /inflight).
let inflight = 0, maxInflight = 0;
const BASH = 'echo LEAK:$OPENCODE_SERVER_PASSWORD; echo LEAK:$OPENCODE_SERVER_PASSWORD > /data/workspace/leak.txt';

function respondToolCall(res, body) {
  const call = { index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: BASH, description: 'test' }) } };
  if (body.stream) {
    const base = { id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'echo' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 0, model: 'echo', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
}

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
      if (req.url === '/test.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      // 300 MB labelled image/png with no content-length, to test the streamed size cap.
      if (req.url === '/big.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        const block = Buffer.alloc(1024 * 1024);
        let sent = 0;
        const pump = () => { while (sent < 300 && !res.destroyed) { sent++; if (!res.write(block)) return res.once('drain', pump); } res.end(); };
        res.on('error', () => {});
        return pump();
      }
      // Redirect to OpenCode's internal port inside the adapter container.
      if (req.url === '/to-loopback.png') {
        res.writeHead(302, { location: 'http://127.0.0.1:4097/global/health' });
        return res.end();
      }
      if (req.url === '/slow.png') {
        return setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); } }, 3000);
      }
      if (req.url === '/inflight') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ inflight, max: maxInflight }));
      }
      if (req.url === '/requests') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(seen));
      }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo', object: 'model' }] }));
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      res.on('close', () => { inflight--; });
      const msgs = body.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const sys = msgs.some((m) => m.role === 'system' && text(m).includes('ADAPTER-SYSTEM-MARKER')) ? 'yes' : 'no';
      const reply = `FAKE-REPLY[sys=${sys}][img=${images(lastUser)}]: ${lastUser ? text(lastUser).slice(-200) : ''}`;
      const toolResult = msgs.find((m) => m.role === 'tool');
      seen.push({ prompt: lastUser ? text(lastUser).slice(-80) : '', tools: (body.tools || []).length, toolResult: toolResult ? text(toolResult).slice(0, 200) : null });
      // "TOOLCALL" asks for a bash call that would print and save the server password;
      // once a tool result comes back, the reply repeats it.
      if (reply.includes('TOOLCALL')) {
        if (!toolResult) return respondToolCall(res, body);
        return respond(res, body, `${reply} TOOL-OUTPUT: ${text(toolResult)}`);
      }
      // "LIMIT" simulates a provider quota: 429 with a one-hour Retry-After.
      if (reply.includes('LIMIT')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
        return res.end(JSON.stringify({ error: { message: 'Fake quota exceeded', type: 'rate_limit_error' } }));
      }
      setTimeout(() => respond(res, body, reply), reply.includes('SLOW') ? 8000 : 0);
    });
  })
  .listen(9000, '0.0.0.0', () => console.log('fake llm on :9000'));
