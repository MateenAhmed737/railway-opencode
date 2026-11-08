# OpenCode on Railway

A single-container deployment of [OpenCode](https://opencode.ai) on Railway. One HTTPS domain serves both:

- the **OpenCode web UI** at `https://YOUR-RAILWAY-DOMAIN/`
- the **OpenCode HTTP API** at the same origin, for example `https://YOUR-RAILWAY-DOMAIN/global/health`

Everything is protected by OpenCode's built-in HTTP Basic authentication. All state (config, provider logins, sessions, workspace, git repos) lives on a Railway volume mounted at `/data`.

```
Browser / opencode CLI ──HTTPS──▶ Railway edge (TLS) ──HTTP $PORT──▶ container
                                                                     tini (PID 1)
                                                                      └─ opencode web --hostname 0.0.0.0 --port $PORT
                                                                         (user: opencode, uid 10001)
                                                                     /data  ◀── Railway volume
```

Verified against OpenCode **1.19.5** (`opencode-ai` on npm). The flags used here come from `opencode web --help` in that version and from the [server docs](https://docs.opencode.ai/docs/server/).

## Files

```
railway-opencode/
├── Dockerfile              # node:22-bookworm-slim + opencode-ai + minimal tools
├── .dockerignore
├── .gitattributes          # keeps *.sh as LF (Windows clones would break otherwise)
├── .gitignore
├── docker/
│   ├── entrypoint.sh       # password guard, /data setup, drop to non-root, exec opencode
│   └── healthcheck.sh      # authenticated probe for Docker HEALTHCHECK
├── railway.json            # build/deploy settings (see the note on Config as Code below)
├── tests/
│   └── smoke-test.sh       # local end-to-end validation
└── README.md
```

## How it works

- **Startup.** `tini` is PID 1. It runs `entrypoint.sh` as root, which:
  1. exits with an error if `OPENCODE_SERVER_PASSWORD` is empty, so the server never starts without auth;
  2. validates `$PORT` (defaults to `4096` if Railway doesn't set it);
  3. creates the `/data` directories and fixes ownership **only on those directories themselves, and only if wrong**. It never runs `chown -R`. Railway mounts volumes as root, so this step is needed on the first boot;
  4. drops to the `opencode` user with `gosu` and `exec`s `opencode web --hostname 0.0.0.0 --port $PORT`.
- **Shutdown.** Railway sends SIGTERM. tini forwards it to OpenCode, which exits right away (tested: exit code 143, under 1 s, no SIGKILL).
- **Same origin.** `opencode web` is one server on one port. It serves the bundled web UI and the full HTTP API (`/global/health`, `/session`, `/doc`, ...).
- **No secrets in the image.** The password and provider credentials are supplied only at runtime.

### What's in the image

The image is kept small (about 1.1 GB, mostly the Node base and OpenCode). It contains only what the server and a typical git workflow need: `tini`, `gosu`, `bash`, `ca-certificates`, `curl`, `git`, `openssh-client`, `ripgrep`, `less`, `procps`, plus Node.js/npm from the base image.

**There is no Python and no C compiler.** If the agent will work on Python projects, or on dependencies that compile native code (`node-gyp`, pip packages with C extensions), add the packages to the `apt-get install` list in the `Dockerfile` and redeploy, for example:

```
python3 python3-pip python3-venv build-essential
```

Don't install them with `apt-get` inside the running container. The system is rebuilt from the image on every deploy, so only `/data` survives.

### Persistent layout

| Path | Purpose |
|---|---|
| `/data/home` | `HOME` (`.gitconfig`, `.ssh`, shell history) |
| `/data/workspace` | Working directory. Clone your repos here |
| `/data/xdg/data` | `XDG_DATA_HOME`. `opencode/auth.json` (provider logins, mode 600), `opencode/opencode.db` (sessions), logs |
| `/data/xdg/config` | `XDG_CONFIG_HOME`. `opencode/opencode.json` global config |
| `/data/xdg/state` | `XDG_STATE_HOME` |
| `/data/xdg/cache` | `XDG_CACHE_HOME` |

---

## 1. Local Docker testing

```bash
docker build -t railway-opencode:test .
```

```bash
docker run --rm -it --name opencode \
  -e PORT=4096 \
  -e OPENCODE_SERVER_PASSWORD="$(openssl rand -base64 24)" \
  -v opencode-data:/data \
  -p 4096:4096 \
  railway-opencode:test
```

Then open http://localhost:4096 and sign in as user `opencode` with the password you set. To see the generated password, set it in a shell variable first instead of inlining `openssl`.

Run the full validation suite. It covers install, password guard, `$PORT`, `0.0.0.0`, non-root, auth on every endpoint, health, writable dirs, graceful shutdown and persistence across restarts:

```bash
./tests/smoke-test.sh
```

On Windows Git Bash, prefix it with `MSYS_NO_PATHCONV=1` so `/data/...` paths aren't rewritten.

## 2. GitHub repository setup

```bash
cd railway-opencode
git init -b main
git add .
git commit -m "OpenCode server for Railway"
gh repo create railway-opencode --private --source . --push
```

Without the `gh` CLI: create an empty **private** repo on github.com, then run `git remote add origin ...` and `git push -u origin main`.

## 3. Railway project creation

1. In Railway: **New Project → Deploy from GitHub repo**, then pick `railway-opencode`. Grant the Railway GitHub app access to the repo if asked.
2. Railway detects the `Dockerfile` and builds with it. ("Railway will always build with a Dockerfile if it finds one.")
3. Before the first deploy succeeds you must add the variables in step 4. Without a password the container exits on purpose, which is expected.

> **Note on `railway.json`.** Railway has deprecated Config as Code. Its docs say *"New services cannot opt into Config as Code"* and existing files stop being read on **2026-12-01**. The included `railway.json` (builder `DOCKERFILE`, restart `ON_FAILURE` with 10 retries) records the intended settings. For a new service, set them in the dashboard. They are all listed below. Railway's replacement is Infrastructure as Code (`.railway/railway.ts`). It isn't included here because I couldn't verify its Dockerfile-builder options.

**Service settings to confirm in the dashboard (Service → Settings):**

| Setting | Value |
|---|---|
| Builder | Dockerfile (`Dockerfile` at repo root) |
| Start command | *(leave empty: the image ENTRYPOINT is used)* |
| Restart policy | On Failure, max 10 retries |
| Replicas | **1**. Railway: "Replicas cannot be used with volumes" |
| Healthcheck path | **leave empty** (see below) |
| Serverless / app sleeping | Off (sleeping would drop live sessions) |

**Why no Railway healthcheck path.** In OpenCode 1.19.5, Basic auth covers **every** route, `/global/health` included (tested: `401` without credentials). Railway's healthcheck sends no credentials and treats only `2xx` as healthy, so `healthcheckPath: /global/health` would fail every deploy. Making the endpoint public would need a reverse proxy, which this design avoids on purpose. Railway only runs healthchecks at deploy time anyway. The image keeps an **authenticated** Docker `HEALTHCHECK`, useful locally and on other hosts, and you can check health yourself with the curl in section 9.

## 4. Environment variables

Set these in **Service → Variables**:

| Variable | Required | Value |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | **yes** | Long random secret, e.g. `openssl rand -base64 32`. The container won't start without it |
| `OPENCODE_SERVER_USERNAME` | no | Defaults to `opencode` |
| `PORT` | no | Railway injects this automatically. Don't set it unless you use a fixed target port |

Already set in the image (override only if you know why): `HOME=/data/home`, `XDG_DATA_HOME=/data/xdg/data`, `XDG_CONFIG_HOME=/data/xdg/config`, `XDG_STATE_HOME=/data/xdg/state`, `XDG_CACHE_HOME=/data/xdg/cache`, `OPENCODE_DISABLE_AUTOUPDATE=true`.

Don't set `RAILWAY_RUN_UID`. The image starts as root only to prepare the volume, and then drops privileges itself.

Don't put provider API keys here unless you want to. Log in once (section 7) and the credential is stored on the volume.

## 5. Persistent volume

1. On the project canvas, right-click the service (or press ⌘K / Ctrl+K) → **Add Volume** / **Attach volume**.
2. **Mount path: `/data`**.
3. Redeploy. On first boot the logs show `Fixing ownership of /data/...` once. Later boots don't.

Facts from the Railway docs worth knowing:
- One volume per service. Volumes are mounted at runtime, not during build.
- Redeploying a service with a volume has **a short downtime**. Railway won't run two deployments on one volume.
- Size limits depend on plan (Hobby 5 GB, Pro 50 GB). You can grow a volume but not shrink it.

## 6. HTTPS domain

**Service → Settings → Networking → Public Networking → Generate Domain.** You get `https://<name>.up.railway.app` with automatic TLS. If Railway asks for a target port, leave it on the detected port. The app listens on whatever `$PORT` Railway injects.

For a custom domain, add the `CNAME` and `TXT` records Railway shows ("both are required").

The browser UI and the API share this one domain. There is nothing else to expose.

## 7. Provider login (persistent)

Credentials are written to `/data/xdg/data/opencode/auth.json` on the volume, so you only log in once.

### Option A: from the web UI (simplest)

Open `https://YOUR-RAILWAY-DOMAIN`, sign in, and use the provider/connect option to add a provider. API-key and OAuth flows that OpenCode supports through the server (`/provider/{id}/oauth/authorize`) run from your browser.

### Option B: Railway shell + `opencode auth login`

Install the Railway CLI, link the project, and open a shell in the running container:

```bash
railway login
```

```bash
railway link
```

```bash
railway ssh
```

> ⚠️ **The Railway shell is root.** Always run OpenCode commands as the `opencode` user. Otherwise `auth.json` is created root-owned and the server can't read it.

Inside the container:

```bash
gosu opencode opencode auth login
```

```bash
gosu opencode opencode auth list
```

- **API key providers:** pick the provider and paste the key. Done.
- **Device-code OAuth** (for example GitHub Copilot via `github.com/login/device`): open the URL shown on your own computer and enter the code. This works fine from a remote shell.
- **Browser-redirect OAuth** that expects a callback on `localhost` (for example ChatGPT login) doesn't work from a headless container. Use Option A, or Option C.

Skip the method picker with `gosu opencode opencode auth login --provider <id> --method "<label>"`.

### Option C: log in locally and copy the credential

Run `opencode auth login` on your own machine. Then copy the matching entry from your local `~/.local/share/opencode/auth.json` into `/data/xdg/data/opencode/auth.json` on the container (as user `opencode`, mode `600`). You can also use the API (section 9): `PUT /auth/<provider-id>` with `{"type":"api","key":"..."}`.

## 8. Browser access

`https://YOUR-RAILWAY-DOMAIN`. The browser shows a Basic-auth prompt. Sign in as `opencode` (or your `OPENCODE_SERVER_USERNAME`) with `OPENCODE_SERVER_PASSWORD`.

Clone projects into `/data/workspace`, either from the OpenCode terminal/tools or via `railway ssh` → `gosu opencode bash` → `cd /data/workspace && git clone ...`.

## 9. API access

Every endpoint needs Basic auth.

```bash
curl -u "opencode:$OPENCODE_SERVER_PASSWORD" https://YOUR-RAILWAY-DOMAIN/global/health
```

Expected response: `{"healthy":true,"version":"1.19.5"}`. Without credentials you get `401` with `www-authenticate: Basic`.

Useful endpoints (from the [server docs](https://docs.opencode.ai/docs/server/)):

| Method & path | Purpose |
|---|---|
| `GET /global/health` | Health and version |
| `GET /doc` | OpenAPI 3.1 spec |
| `GET /session`, `POST /session` | List / create sessions |
| `POST /session/:id/message` | Send a prompt |
| `GET /event` | SSE event stream |
| `GET /config/providers` | Configured providers & models |
| `PUT /auth/:id` | Set provider credentials |

### Local OpenCode CLI → remote server

Install the same OpenCode version locally (`npm i -g opencode-ai@1.19.5`), then:

```bash
export OPENCODE_SERVER_PASSWORD='your-password'
```

```bash
opencode attach https://YOUR-RAILWAY-DOMAIN --dir /data/workspace/my-repo
```

Run a single prompt against the remote server:

```bash
opencode run --attach https://YOUR-RAILWAY-DOMAIN --dir /data/workspace/my-repo "Summarise this repo"
```

Both commands accept `-p/--password` (defaults to `OPENCODE_SERVER_PASSWORD`) and `-u/--username` (defaults to `OPENCODE_SERVER_USERNAME` or `opencode`). Prefer the environment variable so the password stays out of your shell history. `--dir` is a path **on the server**. Use `-c` to continue the last session or `-s <id>` for a specific one.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy crashes with `OPENCODE_SERVER_PASSWORD is not set` | Add the variable (section 4) and redeploy |
| Deploy never becomes healthy | Clear the Healthcheck Path in settings. `/global/health` requires auth |
| "Application failed to respond" | Don't hardcode `PORT`. If you set a target port on the domain, it must match `$PORT` |
| `PermissionDenied ... /data/xdg/...` | Something wrote files as root (usually `opencode` run in `railway ssh` without `gosu`). Fix once: `chown -R opencode:opencode /data/xdg /data/home` |
| `fatal: detected dubious ownership` in git | You're running git as root. Use `gosu opencode git ...` or `gosu opencode bash` |
| `/usr/bin/env: 'bash\r'` at start | CRLF line endings. `.gitattributes` prevents it. Re-clone, or run `git add --renormalize .` |
| 401 in the browser in a loop | Wrong username/password. Check `OPENCODE_SERVER_USERNAME` |
| Need verbose logs | Set the service start command to `/usr/bin/tini -- /usr/local/bin/entrypoint.sh --log-level DEBUG --print-logs`. Extra args go to `opencode web`. Locally: `docker run ... railway-opencode:test --log-level DEBUG` |

### Upgrading OpenCode

Change `ARG OPENCODE_VERSION` in the `Dockerfile`, run `./tests/smoke-test.sh`, then push. Railway redeploys from GitHub. Data on `/data` is kept.

### Backups

- **Railway volume backups** (Service → Backups): manual, or automatic daily (kept 6 days), weekly (27 days) or monthly (89 days). They restore into the same project/environment only. **Wiping a volume deletes its backups.**
- **Off-platform copy**: push your repos in `/data/workspace` to GitHub regularly. To keep OpenCode state, archive it from a Railway shell (`tar czf /data/backup-$(date +%F).tgz -C /data xdg home`) and download it with a tool of your choice. Remember that `auth.json` holds provider secrets.

## Security notes

- OpenCode runs as uid 10001. Root is used only for the entrypoint's directory setup.
- No credentials are in the image or the repo. The password is never logged (the smoke test checks this).
- No unauthenticated route is exposed. TLS is terminated by Railway's edge.
- Anyone with the password can run shell commands in the container through OpenCode. Treat it like an SSH key: use a long random value, and rotate it by changing the variable and redeploying.
