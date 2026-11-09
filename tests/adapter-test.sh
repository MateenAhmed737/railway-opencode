#!/usr/bin/env bash
# End-to-end test of the OpenAI-compatible adapter, using a fake model server
# (tests/fake-llm.js) as an OpenCode custom provider. Requires docker, curl, node 22+.
# Usage: ./tests/adapter-test.sh   (on Windows Git Bash: MSYS_NO_PATHCONV=1 ./tests/adapter-test.sh)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-railway-opencode:test}"
NET="oc-adapter-net-$$"; LLM="oc-fakellm-$$"; NAME="oc-adapter-$$"
PORT=18400; KEY="adapter-$(date +%s)-key"; BASE="http://localhost:${PORT}"
fails=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
expect() { local desc="$1" want="$2" got="$3"; if [[ "$got" == *"$want"* ]]; then pass "$desc"; else fail "$desc (wanted '$want', got '${got:0:200}')"; fi; }
code() { curl -s -m 30 -o /dev/null -w '%{http_code}' "$@"; }
chat() { curl -s -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d "$1"; }

cleanup() { docker rm -f "$NAME" "$LLM" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

# Host path for the bind mount (Git Bash needs a Windows-style path).
SRC="$HERE/fake-llm.js"; command -v cygpath >/dev/null && SRC="$(cygpath -m "$SRC")"

echo "== setup"
docker build -q -t "$IMAGE" "$(dirname "$0")/.." >/dev/null || { echo "build failed"; exit 1; }
docker network create "$NET" >/dev/null
docker run -d --name "$LLM" --network "$NET" -v "$SRC:/fake-llm.js:ro" --entrypoint node "$IMAGE" /fake-llm.js >/dev/null
CFG="{\"provider\":{\"fake\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Fake\",\"options\":{\"baseURL\":\"http://${LLM}:9000/v1\",\"apiKey\":\"x\"},\"models\":{\"echo\":{\"name\":\"Echo\",\"attachment\":true,\"modalities\":{\"input\":[\"text\",\"image\"],\"output\":[\"text\"]}}}}},\"model\":\"fake/echo\"}"
docker run -d --name "$NAME" --network "$NET" -e PORT="$PORT" -e OPENCODE_SERVER_PASSWORD="$KEY" \
  -e OPENCODE_CONFIG_CONTENT="$CFG" -e OPENAI_COMPAT_TIMEOUT_SECONDS=3 -p "${PORT}:${PORT}" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -sf -o /dev/null -u "opencode:${KEY}" "${BASE}/global/health" && break; sleep 1; done
expect "server up" '"healthy":true' "$(curl -s -u "opencode:${KEY}" "${BASE}/global/health")"

echo "== auth"
expect "/v1/models without key -> 401" 401 "$(code "${BASE}/v1/models")"
expect "/v1/models wrong key -> 401" 401 "$(code -H 'Authorization: Bearer wrong' "${BASE}/v1/models")"
expect "/v1/models Bearer key -> 200" 200 "$(code -H "Authorization: Bearer ${KEY}" "${BASE}/v1/models")"
expect "/v1/models Basic auth -> 200" 200 "$(code -u "opencode:${KEY}" "${BASE}/v1/models")"

echo "== models"
expect "lists fake/echo" '"id":"fake/echo"' "$(curl -s -H "Authorization: Bearer ${KEY}" "${BASE}/v1/models")"

echo "== chat"
R="$(chat '{"model":"fake/echo","messages":[{"role":"system","content":"ADAPTER-SYSTEM-MARKER"},{"role":"user","content":"hello adapter"}]}')"
expect "non-stream completion" '"object":"chat.completion"' "$R"
expect "reply text from model" 'FAKE-REPLY[sys=yes][img=0]: hello adapter' "$R"
expect "usage reported" '"total_tokens":18' "$R"
R="$(chat '{"model":"fake/echo","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"stream me"}]}')"
expect "stream chunks" '"object":"chat.completion.chunk"' "$R"
expect "stream carries history" 'User: stream me' "$R"
expect "stream ends with [DONE]" 'data: [DONE]' "$R"
expect "default model when omitted" 'FAKE-REPLY' "$(chat '{"messages":[{"role":"user","content":"x"}]}')"
expect "content parts array accepted" 'FAKE-REPLY[sys=no][img=0]: partsok' "$(chat '{"messages":[{"role":"user","content":[{"type":"text","text":"parts"},{"type":"text","text":"ok"}]}]}')"

echo "== images"
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
expect "data: URL image reaches model" '[img=1]: look' "$(chat "{\"model\":\"fake/echo\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"look\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"${PNG}\"}}]}]}")"
expect "http(s) image downloaded and sent" '[img=1]' "$(chat "{\"model\":\"fake/echo\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"remote\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"http://${LLM}:9000/test.png\"}}]}]}")"
expect "two images in one message" '[img=2]' "$(chat "{\"model\":\"fake/echo\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"two\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"${PNG}\"}},{\"type\":\"image_url\",\"image_url\":\"${PNG}\"}]}]}")"
expect "svg rejected -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/svg+xml;base64,PHN2Zy8+"}}]}]}')"
expect "non-image download -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d "{\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"http://${LLM}:9000/v1/models\"}}]}]}")"
expect "file:// url rejected -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"file:///etc/passwd"}}]}]}')"
expect "audio part -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"AA==","format":"wav"}}]}]}')"

echo "== errors"
expect "bad model id -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"model":"echo","messages":[{"role":"user","content":"x"}]}')"
expect "invalid JSON -> 400" 400 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{')"
expect "unknown /v1 route -> 404 JSON" 'unknown_url' "$(curl -s -H "Authorization: Bearer ${KEY}" "${BASE}/v1/embeddings")"
START=$(date +%s)
RL="$(curl -s -m 60 -i -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"model":"fake/echo","messages":[{"role":"user","content":"LIMIT me"}]}')"
expect "provider rate limit -> 429 fast" '429' "$(echo "$RL" | head -1)"
expect "429 carries Retry-After" 'retry-after:' "$(echo "$RL" | tr 'A-Z' 'a-z')"
expect "429 is OpenAI rate_limit_error" 'rate_limit_error' "$RL"
(( $(date +%s) - START < 20 )) && pass "rate limit reported in $(( $(date +%s) - START ))s (not hung)" || fail "rate limit took $(( $(date +%s) - START ))s"
expect "timeout -> 504" 504 "$(code -H "Authorization: Bearer ${KEY}" -H 'content-type: application/json' "${BASE}/v1/chat/completions" -d '{"messages":[{"role":"user","content":"SLOW please"}]}')"

echo "== cleanup + passthrough"
sleep 1
expect "adapter sessions deleted" '0' "$(curl -s -u "opencode:${KEY}" "${BASE}/session" | grep -o 'openai-compat' | wc -l | tr -d ' ')"
expect "web UI still behind Basic auth" 401 "$(code "${BASE}/")"
expect "web UI served with auth" '<!doctype html>' "$(curl -s -u "opencode:${KEY}" "${BASE}/" | head -c 200 | tr 'A-Z' 'a-z')"
expect "SSE passthrough" 'server.connected' "$(timeout 3 curl -sN -u "opencode:${KEY}" "${BASE}/event" | head -c 300)"
PTY="$(curl -s -u "opencode:${KEY}" -X POST -H 'content-type: application/json' "${BASE}/pty" -d '{"command":"/bin/bash"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
WS="$(node -e '
const [u,a]=process.argv.slice(1);const ws=new WebSocket(u,{headers:{Authorization:a}});let g="";
setTimeout(()=>{console.log("timeout");process.exit()},8000);
ws.onopen=()=>setTimeout(()=>ws.send("echo WS_$((40+2))\n"),300);
ws.onmessage=async e=>{g+=typeof e.data=="string"?e.data:Buffer.from(await e.data.arrayBuffer()).toString();if(g.includes("WS_42")){console.log("ws-ok");process.exit()}};
' "ws://localhost:${PORT}/pty/${PTY}/connect" "Basic $(printf 'opencode:%s' "$KEY" | base64)")"
expect "websocket terminal passthrough" 'ws-ok' "$WS"
expect "OpenCode bound to 127.0.0.1 only" 'yes' "$(docker exec "$NAME" sh -c "grep -qi ' 0100007F:1001 00000000:0000 0A' /proc/net/tcp && echo yes")"
expect "password not in logs" 'clean' "$(docker logs "$NAME" 2>&1 | grep -qF "$KEY" && echo leaked || echo clean)"

echo "== shutdown"
start=$(date +%s); docker stop -t 30 "$NAME" >/dev/null; took=$(( $(date +%s) - start ))
expect "graceful stop exit code" 143 "$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
(( took < 15 )) && pass "stopped in ${took}s" || fail "stop took ${took}s"

echo
(( fails == 0 )) && echo "ALL ADAPTER CHECKS PASSED" || echo "${fails} CHECK(S) FAILED"
exit "$fails"
