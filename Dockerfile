# syntax=docker/dockerfile:1
#
# OpenCode server (web UI + HTTP API) for Railway.
# No credentials are baked into this image. Set OPENCODE_SERVER_PASSWORD at runtime.

FROM node:22-bookworm-slim

# Pin the OpenCode CLI version for reproducible builds. Bump deliberately.
ARG OPENCODE_VERSION=1.19.5
ARG APP_UID=10001
ARG APP_GID=10001

ENV DEBIAN_FRONTEND=noninteractive

# Minimal runtime set:
#   tini (PID 1, signal forwarding), gosu (drop root), bash (entrypoint),
#   ca-certificates + curl (HTTPS, health probe), git + openssh-client (repos),
#   ripgrep (OpenCode code search), less (git pager), procps (ps).
# Need Python or a C toolchain for your projects? Add e.g.
#   python3 python3-pip python3-venv build-essential
# to this list and rebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      less \
      openssh-client \
      procps \
      ripgrep \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true

# Official OpenCode CLI from npm.
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force \
 && opencode --version

# Non-root runtime user. Its home lives on the persistent volume.
RUN groupadd --gid "${APP_GID}" opencode \
 && useradd --uid "${APP_UID}" --gid "${APP_GID}" \
      --home-dir /data/home --no-create-home --shell /bin/bash opencode

# Persistent layout (Railway volume is mounted at /data).
ENV DATA_DIR=/data \
    HOME=/data/home \
    WORKSPACE_DIR=/data/workspace \
    XDG_DATA_HOME=/data/xdg/data \
    XDG_CONFIG_HOME=/data/xdg/config \
    XDG_STATE_HOME=/data/xdg/state \
    XDG_CACHE_HOME=/data/xdg/cache \
    APP_USER=opencode \
    OPENCODE_SERVER_USERNAME=opencode \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENAI_COMPAT_ENABLED=true \
    OPENCODE_INTERNAL_PORT=4097 \
    PORT=4096

# Pre-create the tree so local runs without a volume also work.
RUN mkdir -p /data/home /data/workspace \
      /data/xdg/data /data/xdg/config /data/xdg/state /data/xdg/cache \
 && chown -R opencode:opencode /data

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/healthcheck.sh
# OpenAI-compatible adapter + proxy (plain Node, no dependencies).
COPY docker/openai-adapter/ /opt/openai-adapter/

# Local Docker health status. OpenCode protects /global/health with Basic auth,
# so the probe authenticates. (Railway ignores Docker HEALTHCHECK; see README.)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/healthcheck.sh"]

WORKDIR /data/workspace
# No VOLUME instruction: Railway rejects it. Attach a Railway volume at /data instead.
EXPOSE 4096

# The entrypoint starts as root only to fix ownership of the freshly mounted
# volume (Railway mounts volumes as root), then execs OpenCode as `opencode`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
