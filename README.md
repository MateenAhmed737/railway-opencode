# OpenCode on Railway

A single-container deployment of [OpenCode](https://opencode.ai) on Railway. One HTTPS domain serves:

- the **OpenCode web UI** at `https://YOUR-RAILWAY-DOMAIN/`
- the **native OpenCode HTTP API** at the same origin, for example `https://YOUR-RAILWAY-DOMAIN/global/health`
- an **OpenAI-compatible API** at `https://YOUR-RAILWAY-DOMAIN/v1` (`/v1/models`, `/v1/chat/completions`)

Everything requires authentication. The web UI and native API use OpenCode's built-in HTTP Basic auth. `/v1` accepts the OpenAI-style `Authorization: Bearer <key>`. All state (config, provider logins, sessions, workspace, git repos) lives on a Railway volume mounted at `/data`.

```
Browser / opencode CLI / OpenAI SDK
        │ HTTPS
        ▼
Railway edge (TLS) ──HTTP $PORT──▶ container
                                   tini (PID 1)
                                    └─ node /opt/openai-adapter/server.js   0.0.0.0:$PORT  (user: opencode)
                                        ├─ /v1/*  → OpenAI-compatible adapter
                                        ├─ else   → proxied unchanged (UI, API, SSE, websockets)
                                        └─ opencode web                      127.0.0.1:4097 (user: opencode)
                                   /data  ◀── Railway volume
```

Verified against OpenCode **1.19.5** (`opencode-ai` on npm). The flags used here come from `opencode web --help` in that version and from the [server docs](https://docs.opencode.ai/docs/server/).

If you don't want the OpenAI API, set `OPENAI_COMPAT_ENABLED=false`. OpenCode then binds `0.0.0.0:$PORT` directly, with no adapter process in front.

## Files

```
railway-opencode/
├── Dockerfile                  # node:22-bookworm-slim + opencode-ai + minimal tools
├── .dockerignore
├── .gitattributes              # keeps *.sh as LF (Windows clones would break otherwise)
├── .gitignore
├── docker/
│   ├── entrypoint.sh           # password guard, /data setup, drop to non-root, start adapter or opencode
│   ├── healthcheck.sh          # authenticated probe for Docker HEALTHCHECK
│   └── openai-adapter/
│       └── server.js           # OpenAI-compatible /v1 + proxy + OpenCode supervisor (no npm deps)
├── railway.json                # build/deploy settings (see the note on Config as Code below)
├── examples/
│   └── pi-models.json          # pi coding agent provider config for the /v1 API
├── tests/
│   ├── smoke-test.sh           # base checks: auth, $PORT, non-root, persistence, shutdown
│   ├── adapter-test.sh         # OpenAI API checks against a fake model provider
│   └── fake-llm.js             # tiny OpenAI-style model server used by adapter-test.sh
└── README.md
```

## How it works

- **Startup.** `tini` is PID 1. It runs `entrypoint.sh` as root, which:
  1. exits with an error if `OPENCODE_SERVER_PASSWORD` is empty, so the server never starts without auth;
  2. validates `$PORT` (defaults to `4096` if Railway doesn't set it);
  3. creates the `/data` directories and fixes ownership **only on those directories themselves, and only if wrong**. It never runs `chown -R`. Railway mounts volumes as root, so this step is needed on the first boot;
  4. drops to the `opencode` user with `gosu` and starts the adapter. The adapter launches `opencode web --hostname 127.0.0.1 --port 4097`, waits until OpenCode reports healthy, and only then opens the public `$PORT`.
- **Shutdown.** Railway sends SIGTERM. The adapter stops accepting connections and forwards SIGTERM to OpenCode, which normally exits within a second. If OpenCode is still running after `OPENCODE_SHUTDOWN_GRACE_SECONDS` (default 8), the adapter force-stops it. OpenCode's SQLite store is crash-safe. Either way the container exits with code 143.
- **Same origin.** Everything is on one port and one domain. OpenCode itself is reachable only on `127.0.0.1` inside the container.
- **No secrets in the image.** The password and provider credentials are supplied only at runtime.

### What's in the image

The image is about 1.1 GB, mostly the Node base and OpenCode. It contains only what the server and a typical git workflow need: `tini`, `gosu`, `bash`, `ca-certificates`, `curl`, `git`, `openssh-client`, `ripgrep`, `less`, `procps`, plus Node.js/npm from the base image (which the adapter also uses).

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

Test suites. Both need Docker. On Windows Git Bash, prefix them with `MSYS_NO_PATHCONV=1`.

```bash
./tests/smoke-test.sh
```

That runs 18 checks: install, password guard, `$PORT`, `0.0.0.0`, non-root, auth on every endpoint, health, writable dirs, graceful shutdown, and persistence across restarts.

```bash
./tests/adapter-test.sh
```

That runs 34 checks: `/v1` auth, models, chat, streaming, images (data URLs, downloaded URLs, multiple images, rejected types), error handling, timeout, session cleanup, passthrough of the UI, SSE and the websocket terminal, internal-only OpenCode port, and shutdown. It uses a fake model provider, so no API key is needed.

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

**Why no Railway healthcheck path.** In OpenCode 1.19.5, Basic auth covers **every** route, `/global/health` included (tested: `401` without credentials). Railway's healthcheck sends no credentials and treats only `2xx` as healthy, so `healthcheckPath: /global/health` would fail every deploy. This project deliberately exposes no unauthenticated route. Railway only runs healthchecks at deploy time anyway. The image keeps an **authenticated** Docker `HEALTHCHECK`, useful locally and on other hosts.

## 4. Environment variables

Set these in **Service → Variables**:

| Variable | Required | Value |
|---|---|---|
| `OPENCODE_SERVER_PASSWORD` | **yes** | Long random secret, e.g. `openssl rand -base64 32`. The container won't start without it |
| `OPENCODE_SERVER_USERNAME` | no | Defaults to `opencode` |
| `OPENAI_COMPAT_API_KEY` | no | Separate Bearer key for `/v1`. Defaults to `OPENCODE_SERVER_PASSWORD`. Set it to give API clients a key that can't log in to the web UI |
| `OPENAI_COMPAT_ENABLED` | no | `true` (default). `false` removes the adapter and OpenCode listens on `$PORT` directly |
| `OPENAI_COMPAT_AGENT` | no | OpenCode agent for `/v1` requests (e.g. `build`, `plan`). Empty = OpenCode's default |
| `OPENAI_COMPAT_DIRECTORY` | no | Project directory for `/v1` requests. Default `/data/workspace` |
| `OPENAI_COMPAT_TIMEOUT_SECONDS` | no | Max time per `/v1` request. Default `600` |
| `OPENAI_COMPAT_KEEP_SESSIONS` | no | `true` keeps each `/v1` request's session visible in the web UI. Default: they're deleted afterwards |
| `OPENAI_COMPAT_MAX_BODY_MB` | no | Max `/v1` request size, including base64 images. Default `25` |
| `OPENAI_COMPAT_MAX_IMAGE_MB` | no | Max size of an image the adapter downloads from an `http(s)` URL. Default `10` |
| `PORT` | no | Railway injects this automatically. Don't set it unless you use a fixed target port |

Already set in the image (override only if you know why): `HOME=/data/home`, `XDG_*` under `/data/xdg`, `OPENCODE_DISABLE_AUTOUPDATE=true`, `OPENCODE_INTERNAL_PORT=4097`, `OPENCODE_SHUTDOWN_GRACE_SECONDS=8` (implicit default), `OPENCODE_STARTUP_TIMEOUT_SECONDS=180` (implicit default).

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
- The Dockerfile deliberately has **no `VOLUME` instruction**. Railway's Dockerfile validation rejects it.

## 6. HTTPS domain

**Service → Settings → Networking → Public Networking → Generate Domain.** You get `https://<name>.up.railway.app` with automatic TLS. If Railway asks for a target port, leave it on the detected port. The app listens on whatever `$PORT` Railway injects.

For a custom domain, add the `CNAME` and `TXT` records Railway shows ("both are required").

The browser UI, the native API and the OpenAI API all share this one domain. There is nothing else to expose.

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

### Native OpenCode API

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
| `POST /session/:id/message` | Send a prompt. Body: `{"parts":[{"type":"text","text":"..."}],"model":{"providerID":"...","modelID":"..."}}` |
| `GET /event` | SSE event stream |
| `GET /config/providers` | Configured providers & models |
| `PUT /auth/:id` | Set provider credentials |

### OpenAI-compatible API

Base URL `https://YOUR-RAILWAY-DOMAIN/v1`. The API key is `OPENAI_COMPAT_API_KEY`, or `OPENCODE_SERVER_PASSWORD` if that isn't set. Basic auth also works.

Model IDs are `providerID/modelID`, exactly as `GET /v1/models` lists them (for example `anthropic/claude-sonnet-4-5`). Omit `model`, or use `"default"`, to get OpenCode's default model.

```bash
curl https://YOUR-RAILWAY-DOMAIN/v1/models \
  -H "Authorization: Bearer $OPENCODE_SERVER_PASSWORD"
```

```bash
curl https://YOUR-RAILWAY-DOMAIN/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_SERVER_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-5","messages":[{"role":"user","content":"List the files in my-repo"}]}'
```

Python (`openai` package):

```python
from openai import OpenAI
client = OpenAI(base_url="https://YOUR-RAILWAY-DOMAIN/v1", api_key="YOUR_KEY")
r = client.chat.completions.create(model="anthropic/claude-sonnet-4-5",
                                   messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)
```

Node (`openai` package): `new OpenAI({ baseURL: "https://YOUR-RAILWAY-DOMAIN/v1", apiKey: "YOUR_KEY" })`. This was tested with the official `openai` npm SDK v4: model listing, chat, streaming, and a 401 `AuthenticationError` on a bad key.

**How a request is handled, and what that means for you:**

- Each request creates a new OpenCode session, sends one prompt, returns the final answer text, and then deletes the session. Set `OPENAI_COMPAT_KEEP_SESSIONS=true` to keep sessions so you can inspect them in the web UI. The session ID is returned in the `x-opencode-session` response header.
- **It's the agent, not a bare model.** OpenCode may read files, run commands and edit code in the project directory before it answers. The response contains only the final text. Pick a different project folder per request with the header `x-opencode-directory: /data/workspace/my-repo`, and a different agent with `x-opencode-agent: plan`.
- `system`/`developer` messages become OpenCode's system prompt. Earlier user/assistant turns are flattened into a transcript inside the new prompt, because OpenCode sessions can't be pre-filled with assistant turns.
- **Streaming is buffered.** With `"stream": true` you get a valid SSE response (role chunk, keep-alive comments every 15 s, then the full answer, then `[DONE]`), but the text arrives in one chunk when OpenCode finishes, not token by token. `stream_options.include_usage` is supported.
- **Images and PDFs are supported** in user messages, using standard OpenAI content parts:
  - `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`. A plain `http(s)` URL also works: the adapter downloads it, up to `OPENAI_COMPAT_MAX_IMAGE_MB`.
  - `{"type":"file","file":{"file_data":"data:application/pdf;base64,...","filename":"x.pdf"}}`. `file_id` isn't supported.
  - Accepted types are PNG, JPEG, GIF, WebP and PDF. Anything else (SVG, audio, `file://` URLs) returns a clear `400`.
  - Use a model that accepts images. Tested free ones that correctly described a test image: `opencode/nemotron-3.5-super-vl-free`, `opencode/glm-5.3-flash-free`, `opencode/mimo-v2.6-flash-free`, `opencode/deepseek-v4.1-flash-free` and `opencode/inkling-2-small-free`. `opencode/crouton-alpha-free` is listed as image/PDF-capable but answered "not available in your country" from the test location. Text-only models such as `opencode/big-pickle` reply that they can't see images.
- OpenAI `tools`/function calling is ignored, because OpenCode uses its own tools. Audio input isn't supported. Sampling parameters (`temperature`, `max_tokens`, ...) are ignored.
- If OpenCode stops to ask for a permission approval, the request waits until `OPENAI_COMPAT_TIMEOUT_SECONDS` and then returns `504`. To avoid that, set permissions in `/data/xdg/config/opencode/opencode.json` (see the [OpenCode permissions docs](https://docs.opencode.ai/docs/config/)).
- Only `GET /v1/models` and `POST /v1/chat/completions` exist. Other `/v1/*` paths return an OpenAI-style `404`.

### Using it from the pi coding agent

[`examples/pi-models.json`](examples/pi-models.json) is a ready-made custom provider for [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`), pointing at this server's `/v1` with OpenCode's free models. It was tested with pi 1.5.0: `--list-models`, plain prompts, and file tasks.

1. Copy it to `~/.pi/agent/models.json`, or merge its `providers` entry into your existing file. Change `baseUrl` if your domain differs.
2. Put your key in the environment. The file reads it with `$OPENCODE_RAILWAY_KEY`:
   ```bash
   export OPENCODE_RAILWAY_KEY='your OPENAI_COMPAT_API_KEY or OPENCODE_SERVER_PASSWORD'
   ```
3. Check that pi sees the models, then use one:
   ```bash
   pi --list-models opencode-railway
   ```
   ```bash
   pi --model opencode-railway/opencode/big-pickle
   ```
   Inside pi, `/model` also shows them, and `Ctrl+S` saves one as the default.

**Important: the work happens on the server, not on your machine.** pi offers its tools (read, edit, bash) to the model, but the adapter returns only OpenCode's final answer and never asks pi to run a tool. OpenCode does the work with its own tools, inside the Railway container, in `/data/workspace` or the folder set by `OPENAI_COMPAT_DIRECTORY`. In the test, "create a file in the current directory" created it in `/data/workspace` on the server, and pi's local folder stayed empty. Treat pi here as a chat front end to your remote OpenCode agent. To have pi edit local files itself, it needs a raw model provider (e.g. pi's built-in `opencode` provider with an OpenCode Zen API key, or any other provider), not this adapter.

Other notes:
- **Keep the model list current.** The free models change over time. Refresh the `models` list from `GET /v1/models`; the `id` must be exactly `opencode/<model>` as listed there.
- **The `compat` flags match what the adapter handles:** `system` role instead of `developer`, no `store` or `reasoning_effort`, usage reported in streams, and `max_tokens` (which the adapter ignores).
- **Images work with the six vision models,** which are declared `"input": ["text", "image"]`. Attach a screenshot with `pi @screenshot.png "what's wrong here?"` or by pasting it in the TUI. This was tested with pi 1.5.0 and `nemotron-3.5-super-vl-free`. The other five models stay text-only, so pi won't send them images.
- **Responses are buffered.** They arrive in one piece rather than token by token.

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
| Build fails: "The Dockerfile failed validation" | Make sure the Dockerfile has no `VOLUME` line. Railway rejects it. Fixed in this repo |
| Deploy crashes with `OPENCODE_SERVER_PASSWORD is not set` | Add the variable (section 4) and redeploy |
| Deploy never becomes healthy | Clear the Healthcheck Path in settings. `/global/health` requires auth |
| "Application failed to respond" right after deploy | OpenCode is still starting. The public port opens once it's healthy (usually a few seconds). If it persists: don't hardcode `PORT`, and any target port on the domain must match `$PORT` |
| `/v1/...` returns `401 invalid_api_key` | Use `Authorization: Bearer <OPENAI_COMPAT_API_KEY or OPENCODE_SERVER_PASSWORD>` |
| `/v1/chat/completions` returns `504` | OpenCode took longer than `OPENAI_COMPAT_TIMEOUT_SECONDS`, often because it's waiting for a permission approval. Raise the timeout or configure permissions |
| `/v1/chat/completions` returns `401 ProviderAuthError` | The chosen provider isn't logged in. See section 7 |
| `/v1/...` returns HTML | `OPENAI_COMPAT_ENABLED` is `false`, so OpenCode serves its web UI for unknown paths |
| `PermissionDenied ... /data/xdg/...` | Something wrote files as root (usually `opencode` run in `railway ssh` without `gosu`). Fix once: `chown -R opencode:opencode /data/xdg /data/home` |
| `fatal: detected dubious ownership` in git | You're running git as root. Use `gosu opencode git ...` or `gosu opencode bash` |
| `/usr/bin/env: 'bash\r'` at start | CRLF line endings. `.gitattributes` prevents it. Re-clone, or run `git add --renormalize .` |
| 401 in the browser in a loop | Wrong username/password. Check `OPENCODE_SERVER_USERNAME` |
| Need verbose logs | Set the service start command to `/usr/bin/tini -- /usr/local/bin/entrypoint.sh --log-level DEBUG --print-logs`. Extra args go to `opencode web`. Locally: `docker run ... railway-opencode:test --log-level DEBUG` |

### Upgrading OpenCode

Change `ARG OPENCODE_VERSION` in the `Dockerfile`, run both test suites, then push. Railway redeploys from GitHub. Data on `/data` is kept.

### Backups

- **Railway volume backups** (Service → Backups): manual, or automatic daily (kept 6 days), weekly (27 days) or monthly (89 days). They restore into the same project/environment only. **Wiping a volume deletes its backups.**
- **Off-platform copy**: push your repos in `/data/workspace` to GitHub regularly. To keep OpenCode state, archive it from a Railway shell (`tar czf /data/backup-$(date +%F).tgz -C /data xdg home`) and download it with a tool of your choice. Remember that `auth.json` holds provider secrets.

## Security notes

- The adapter and OpenCode run as uid 10001. Root is used only for the entrypoint's directory setup.
- OpenCode listens on `127.0.0.1` only. Every public request passes through the adapter, and every route needs credentials: `/v1/*` checks the Bearer key (constant-time compare), and everything else is checked by OpenCode's own Basic auth.
- No credentials are in the image or the repo. The password is never logged (both test suites check this).
- TLS is terminated by Railway's edge.
- Anyone with the password **or the `/v1` key** can make OpenCode run shell commands in the container. Treat both like SSH keys: use long random values, give API clients a separate `OPENAI_COMPAT_API_KEY`, and rotate by changing the variable and redeploying.
