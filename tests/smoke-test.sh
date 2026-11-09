#!/usr/bin/env bash
# Local end-to-end validation of the image. Requires docker and curl.
# Usage: ./tests/smoke-test.sh
set -uo pipefail

IMAGE="${IMAGE:-railway-opencode:test}"
NAME="oc-smoke-$$"
VOL="oc-smoke-vol-$$"
PORT=18123
PASS="smoke-$(date +%s)-password"
BASE="http://localhost:${PORT}"
fails=0

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
check() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }
wait_up() { for _ in $(seq 1 60); do [[ "$(code -u "opencode:${PASS}" "${BASE}/global/health")" == 200 ]] && return 0; sleep 1; done; return 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm -f "$VOL" >/dev/null 2>&1; }
trap cleanup EXIT

echo "== build"
docker build -q -t "$IMAGE" "$(dirname "$0")/.." >/dev/null || { echo "build failed"; exit 1; }
check "opencode CLI installed" docker run --rm --entrypoint opencode "$IMAGE" --version

echo "== password guard"
if docker run --rm "$IMAGE" >/dev/null 2>&1; then fail "starts without password"; else pass "refuses to start without OPENCODE_SERVER_PASSWORD"; fi

echo "== start (root-owned empty volume, like Railway)"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/data" --entrypoint sh "$IMAGE" -c 'chown root:root /data && rm -rf /data/*' >/dev/null
docker run -d --name "$NAME" -e PORT="$PORT" -e OPENCODE_SERVER_PASSWORD="$PASS" \
  -v "$VOL:/data" -p "${PORT}:${PORT}" "$IMAGE" >/dev/null
check "server answers on \$PORT=${PORT}" wait_up
check "listens on 0.0.0.0" docker exec "$NAME" sh -c "grep -qi ' 00000000:$(printf '%04X' "$PORT") 00000000:0000 0A' /proc/net/tcp"
check "opencode runs as non-root" docker exec "$NAME" sh -c 'ps -o user= -C opencode | grep -qx opencode'
check "password not in logs" bash -c "! docker logs $NAME 2>&1 | grep -qF '$PASS'"

echo "== auth"
for p in / /global/health /doc /session; do
  [[ "$(code "${BASE}${p}")" == 401 ]] && pass "unauthenticated ${p} -> 401" || fail "unauthenticated ${p} not 401"
done
[[ "$(code -u opencode:wrong "${BASE}/global/health")" == 401 ]] && pass "wrong password -> 401" || fail "wrong password accepted"
check "health returns healthy:true" bash -c "curl -fs -u 'opencode:${PASS}' ${BASE}/global/health | grep -q '\"healthy\":true'"
check "web UI served on same port" bash -c "curl -fs -u 'opencode:${PASS}' ${BASE}/ | grep -qi '<!doctype html>'"

echo "== persistence"
check "persistent dirs writable" docker exec -u opencode "$NAME" bash -c \
  'for d in /data/home /data/workspace /data/xdg/data /data/xdg/config /data/xdg/state /data/xdg/cache; do touch "$d/.w" && rm "$d/.w" || exit 1; done'
SID="$(curl -s -u "opencode:${PASS}" -X POST -H 'content-type: application/json' "${BASE}/session" -d '{"title":"smoke"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
docker exec -u opencode "$NAME" bash -c 'echo keep > /data/workspace/keep.txt'

echo "== graceful shutdown"
start=$(date +%s); docker stop -t 30 "$NAME" >/dev/null; took=$(( $(date +%s) - start ))
ec="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
(( took < 25 )) && [[ "$ec" != 137 ]] && pass "stopped on SIGTERM in ${took}s (exit ${ec})" || fail "shutdown took ${took}s exit ${ec}"

docker start "$NAME" >/dev/null
check "restarts cleanly" wait_up
check "session survived restart" bash -c "curl -fs -u 'opencode:${PASS}' ${BASE}/session | grep -q '${SID:-none}'"
check "workspace file survived restart" docker exec "$NAME" test -f /data/workspace/keep.txt

echo
(( fails == 0 )) && echo "ALL CHECKS PASSED" || echo "${fails} CHECK(S) FAILED"
exit "$fails"
