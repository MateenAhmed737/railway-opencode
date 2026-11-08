#!/usr/bin/env bash
# Authenticated container health probe (used by Docker HEALTHCHECK).
# Credentials are fed to curl through a config on stdin, so they never
# appear in the process list or in `docker inspect`.
set -euo pipefail
printf 'user = "%s:%s"\n' "${OPENCODE_SERVER_USERNAME:-opencode}" "${OPENCODE_SERVER_PASSWORD:?}" \
  | curl -fsS --max-time 5 -K - "http://127.0.0.1:${PORT:-4096}/global/health" \
  | grep -q '"healthy":true'
