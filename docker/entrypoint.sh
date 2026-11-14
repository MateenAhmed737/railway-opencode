#!/usr/bin/env bash
# Entrypoint for the OpenCode Railway container.
#  1. Refuses to start without OPENCODE_SERVER_PASSWORD.
#  2. Prepares /data (non-recursive ownership fixes only).
#  3. Drops to the non-root user and execs the OpenAI adapter on 0.0.0.0:$PORT,
#     which runs `opencode web` on 127.0.0.1:$OPENCODE_INTERNAL_PORT. With
#     OPENAI_COMPAT_ENABLED=false it execs `opencode web` on 0.0.0.0:$PORT instead.
set -Eeuo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

APP_USER="${APP_USER:-opencode}"
DATA_DIR="${DATA_DIR:-/data}"
WORKSPACE_DIR="${WORKSPACE_DIR:-${DATA_DIR}/workspace}"
PORT="${PORT:-4096}"
HOSTNAME_BIND="0.0.0.0"

# ---- 1. Authentication guard -----------------------------------------------
if [[ -z "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
  die "OPENCODE_SERVER_PASSWORD is not set. Refusing to start an unauthenticated server."
fi
if (( ${#OPENCODE_SERVER_PASSWORD} < 12 )); then
  log "WARNING: OPENCODE_SERVER_PASSWORD is shorter than 12 characters. Use a long random value."
fi
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
export OPENCODE_SERVER_PASSWORD

# ---- 2. Port validation -----------------------------------------------------
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  die "PORT must be an integer between 1 and 65535 (got '${PORT}')."
fi

# ---- 3. Persistent directories ----------------------------------------------
DIRS=(
  "${DATA_DIR}"
  "${HOME}"
  "${WORKSPACE_DIR}"
  "${DATA_DIR}/xdg"
  "${XDG_DATA_HOME}"
  "${XDG_CONFIG_HOME}"
  "${XDG_STATE_HOME}"
  "${XDG_CACHE_HOME}"
)

if [[ "$(id -u)" -eq 0 ]]; then
  APP_UID="$(id -u "${APP_USER}")"
  APP_GID="$(id -g "${APP_USER}")"
  for d in "${DIRS[@]}"; do
    mkdir -p "${d}"
    # Only touch the directory itself, and only when ownership is wrong.
    # Never chown -R: the workspace may hold large repos.
    if [[ "$(stat -c '%u:%g' "${d}")" != "${APP_UID}:${APP_GID}" ]]; then
      log "Fixing ownership of ${d}"
      chown "${APP_UID}:${APP_GID}" "${d}"
    fi
  done
  # Home and XDG dirs hold credentials (auth.json) - keep them private.
  chmod 0700 "${HOME}" "${DATA_DIR}/xdg" "${XDG_DATA_HOME}" "${XDG_CONFIG_HOME}" \
             "${XDG_STATE_HOME}" "${XDG_CACHE_HOME}"
  RUN_AS=(gosu "${APP_USER}")
else
  for d in "${DIRS[@]}"; do mkdir -p "${d}" 2>/dev/null || true; done
  RUN_AS=()
fi

for d in "${DIRS[@]}"; do
  "${RUN_AS[@]}" test -w "${d}" || die "${d} is not writable by ${APP_USER}."
done

# Sensible one-time git defaults for the runtime user (stored in $HOME/.gitconfig).
if ! "${RUN_AS[@]}" git config --global --get init.defaultBranch >/dev/null 2>&1; then
  "${RUN_AS[@]}" git config --global init.defaultBranch main
fi

cd "${WORKSPACE_DIR}"

# ---- 4. Launch ---------------------------------------------------------------
# Run every opencode invocation as the app user: even `--version` writes logs
# under $XDG_DATA_HOME, and root-owned files there would break the server.
log "OpenCode $("${RUN_AS[@]}" opencode --version 2>/dev/null || echo '?') starting"
log "  listen     : ${HOSTNAME_BIND}:${PORT}"
log "  auth       : HTTP Basic, user '${OPENCODE_SERVER_USERNAME}' (password set, not shown)"
log "  workspace  : ${WORKSPACE_DIR}"
log "  data/config: ${XDG_DATA_HOME} / ${XDG_CONFIG_HOME}"
log "  run as     : ${APP_USER}"

OPENAI_COMPAT_ENABLED="${OPENAI_COMPAT_ENABLED:-true}"
if [[ "${OPENAI_COMPAT_ENABLED,,}" =~ ^(1|true|yes)$ ]]; then
  INTERNAL_PORT="${OPENCODE_INTERNAL_PORT:-4097}"
  [[ "${INTERNAL_PORT}" == "${PORT}" ]] && INTERNAL_PORT=$(( PORT + 1 ))
  export OPENCODE_INTERNAL_PORT="${INTERNAL_PORT}"
  log "  openai api : /v1/models, /v1/chat/completions (Bearer key = $([[ -n "${OPENAI_COMPAT_API_KEY:-}" ]] && echo OPENAI_COMPAT_API_KEY || echo OPENCODE_SERVER_PASSWORD))"
  log "  opencode   : 127.0.0.1:${INTERNAL_PORT} (internal, behind the adapter)"
  # The adapter owns the public port, supervises OpenCode and forwards signals.
  # It starts as root (when we are root) only to launch OpenCode as ${APP_USER} with
  # an internal password, then drops to ${APP_USER} itself before listening. That
  # keeps the public password and API key out of reach of OpenCode's tools.
  export APP_USER
  exec node /opt/openai-adapter/server.js "$@"
fi

# Adapter disabled: OpenCode owns the public port directly.
# exec so tini's signals (SIGTERM from Railway) reach OpenCode directly.
exec "${RUN_AS[@]}" opencode web \
  --hostname "${HOSTNAME_BIND}" \
  --port "${PORT}" \
  "$@"
