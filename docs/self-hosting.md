# Self-hosting (home PC or your own server)

Run the same image as on Railway, on a machine whose outgoing IP is yours, with one HTTPS front in front of it. Railway keeps working as before; this is an extra way to deploy, not a replacement.

**Why.** OpenCode's free `opencode/*` models stopped working on Railway with "Free usage exceeded" (`free_tier_limit`), while the same image on a home PC works. The free tier appears to count requests **per outgoing IP per day**, resetting at 00:00 UTC, and logging in with a free OpenCode account does not lift it. Railway apps share outgoing IPs, so the likely cause is other apps using up the same IP's quota. That last part is an inference, not proven. The fix this guide tries is simple: send OpenCode's traffic from an IP nobody else uses.

Two routes, same `docker-compose.yml`, chosen with `COMPOSE_PROFILES` in `.env`:

| | **A. Home PC + Cloudflare Tunnel** (`tunnel`) | **B. Server + Caddy** (`caddy`) |
|---|---|---|
| Outgoing IP | Your home IP (already proven to work with the free models) | The server's public IPv4 |
| Cost | Free, plus a domain (a cheap one, a few dollars a year, is enough) | Free or cheap server; no domain needed (`sslip.io`) |
| Open ports | None. `cloudflared` dials out to Cloudflare, works behind NAT/CGNAT | 80 and 443 |
| Uptime | Only while the PC is on and online | 24/7 |

```
A:  client ─HTTPS─▶ Cloudflare ─tunnel─▶ cloudflared ─┐
B:  client ─HTTPS──────────────────────▶ caddy :443 ──┴─http─▶ opencode:4096 (adapter) ─▶ opencode web 127.0.0.1:4097
                                                                  /data ◀── named volume "opencode_data"
```

Neither the adapter port (4096) nor OpenCode's internal port (4097) is published on the host.

---

## A. Home PC (or any always-on machine) + Cloudflare Tunnel

### What you need

- The PC with **Docker**: Docker Desktop on Windows or macOS, Docker Engine on Linux.
- A **domain on Cloudflare** (free plan). A named tunnel publishes a hostname under a domain you control. Cloudflare's no-account "quick tunnels" (`*.trycloudflare.com`) are **not** an option here: Cloudflare's docs say *"Quick Tunnels do not support Server-Sent Events (SSE)"*, which the web UI and streaming `/v1` responses need, and they are meant for testing only, with no uptime guarantee and a URL that changes on every restart.

### 1. Put the domain on Cloudflare

Cloudflare dashboard → **Add a domain** → Free plan → change the nameservers at your registrar to the two Cloudflare shows. Wait until Cloudflare says the domain is **Active**.

### 2. Create the tunnel

Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared** → give it a name (e.g. `opencode`).

1. On the install step pick **Docker**. The command shown contains `--token eyJ...`. Copy only that long token. You don't need to run the command; compose runs `cloudflared` for you.
2. **Public hostname**: subdomain `opencode` (or anything), your domain, then **Service**: type `HTTP`, URL `opencode:4096`. (`opencode` is the compose service name, reachable from the `cloudflared` container.) Save.

The exact menu names move around in Cloudflare's dashboard; the pieces you need are always the token and a public hostname pointing at `http://opencode:4096`.

### 3. Configure and start

```bash
git clone https://github.com/MateenAhmed737/railway-opencode.git
cd railway-opencode
cp .env.example .env
```

Edit `.env`:

```ini
COMPOSE_PROFILES=tunnel
OPENCODE_SERVER_PASSWORD=<openssl rand -base64 32>
OPENAI_COMPAT_API_KEY=<another long random value>
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

(On Windows without `openssl`, any password manager's 32+ character random password is fine.)

```bash
docker compose up -d --build
docker compose ps        # opencode should become "healthy" within a minute
docker compose logs cloudflared | tail   # look for "Registered tunnel connection"
```

The tunnel page in Cloudflare should now show the tunnel as **Healthy**. Go to [Verify](#verify) with `BASE=https://opencode.yourdomain.com`.

### 4. Keep it running across reboots

Both containers have `restart: unless-stopped`, so they come back whenever Docker starts. Make Docker itself start on boot:

- **Windows (Docker Desktop):** Settings → General → **Start Docker Desktop when you sign in to your computer**. Docker Desktop starts when you **log in**, not at boot, so set Windows to sign in automatically or stay signed in. Also set **Power & battery → Sleep → Never** while plugged in, or the server disappears when the PC sleeps.
- **macOS (Docker Desktop):** the same "Start Docker Desktop when you sign in" setting; disable sleep in System Settings → Energy.
- **Linux (Docker Engine):** `sudo systemctl enable --now docker`. Nothing else is needed.

### Cloudflare things to know

- **Long non-streaming requests time out at about 125 s.** Cloudflare returns error **524** when the origin hasn't sent a response within its proxy read timeout (125 s by default per Cloudflare's 524 docs; adjustable only on Enterprise). A non-streaming `/v1/chat/completions` sends nothing until the model is finished, so a long agentic answer can hit it. **Use `"stream": true` for long requests.** The adapter then sends the response headers and a first chunk immediately and a `: keepalive` comment every 15 s until the answer is ready. (Railway and Caddy have no such limit.)
- **Bot protection.** If API clients get an HTML challenge page or 403 instead of JSON, turn off **Bot Fight Mode** (Security → Bots) for the domain.
- **Websockets** (the web UI's terminal, `/pty/:id/connect`) are proxied by Cloudflare and `cloudflared`; there's nothing to enable.

---

## B. Any server with its own public IPv4 + Caddy

Works on any small Linux VM or VPS (Ubuntu 22.04/24.04 assumed), **amd64 or arm64**. Caddy gets a real Let's Encrypt certificate automatically.

### 1. The server

- It must have its **own public IPv4** (check: the IP shown in the provider console is the one `curl -4 https://api.ipify.org` prints on the server). An IPv6-only server won't do: the free-tier check is about the outgoing IPv4.
- In the provider's firewall (often called security group, VPC firewall or network rules), allow **inbound TCP 22, 80 and 443** (and UDP 443 for HTTP/3, optional). Port 80 is needed for the certificate.

### 2. Swap (1 GB machines)

Measured with this stack: OpenCode uses about **190 MB idle** and about **410 MB after its first request**; Caddy about 11 MB. That fits in 1 GB, but leaves little room for the OS, Docker builds and OpenCode running tools. On a machine with 1 GB of RAM, add 2 GB of swap first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

The image is about 1 GB on disk (amd64; 0.8 GB on arm64), so keep a few GB free.

### 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version
```

`get.docker.com` is Docker's official convenience script; it enables Docker on boot. (Docker publishes ports past `ufw`, so `ufw` rules don't block or open Caddy's ports. Use the provider firewall.)

### 4. Configure and start

Pick the hostname:

- **No domain:** `<server-ip>.sslip.io`, e.g. `203.0.113.7.sslip.io`. sslip.io answers DNS with the IP written in the name, so it works immediately and gets a real certificate.
- **Own domain:** an `A` record (e.g. `opencode.example.com`) pointing at the server IP.

```bash
git clone https://github.com/MateenAhmed737/railway-opencode.git
cd railway-opencode
cp .env.example .env
nano .env
```

```ini
COMPOSE_PROFILES=caddy
SITE_ADDRESS=203.0.113.7.sslip.io
OPENCODE_SERVER_PASSWORD=<openssl rand -base64 32>
OPENAI_COMPAT_API_KEY=<openssl rand -base64 32>
```

```bash
docker compose up -d --build
docker compose ps
docker compose logs caddy | grep -i certificate   # "certificate obtained successfully"
```

If the certificate fails, it's almost always port 80/443 not reachable from the internet (provider firewall) or `SITE_ADDRESS` not matching the server's IP.

Go to [Verify](#verify) with `BASE=https://203.0.113.7.sslip.io`.

---

## Verify

Run these from any computer (checks 1 to 4 go through the public hostname). Set:

```bash
BASE=https://your-hostname
PASS='<OPENCODE_SERVER_PASSWORD>'
KEY='<OPENAI_COMPAT_API_KEY>'
```

```bash
# 1. Health (Basic auth) -> {"healthy":true,"version":"1.19.5"}
curl -s -u "opencode:$PASS" "$BASE/global/health"

# 2. Auth is enforced -> 401 and 401
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/global/health"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/models"

# 3. Models -> a list including opencode/glm-5.3-flash-free
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models"

# 4. Web UI: open $BASE in a browser, user "opencode", the password.

# 5. On the machine running the stack: which IP OpenCode's traffic leaves from
#    (should be your home / server IP):
docker compose exec opencode curl -s https://api.ipify.org; echo
```

**The test that matters**, a free model from this machine's IP:

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"opencode/glm-5.3-flash-free","messages":[{"role":"user","content":"Reply with the word pong."}]}'
```

- **200** with `"content":"pong"` (or similar): the free models work from this IP. Done.
- **429** with `"type":"rate_limit_error"` and `"code":"free_tier_limit"`: OpenCode's free tier refused this IP too. The response's `Retry-After` and message say when OpenCode would retry. If this is a fresh IP that has made only a few requests, the per-IP explanation doesn't fully hold for it (the provider's IP range may be limited as a whole, or the limit may work differently). Options: try a different machine/network, wait for the 00:00 UTC reset, or use a provider of your own (README section 7) and its models.

Streaming check (keep-alives arrive every 15 s while the model works; use this form for long requests through Cloudflare):

```bash
curl -sN -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"opencode/glm-5.3-flash-free","stream":true,"messages":[{"role":"user","content":"Count to 5."}]}'
```

---

## Day-to-day

| Task | Command |
|---|---|
| Logs | `docker compose logs -f opencode` (rotated: 3 × 10 MB per service) |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (data kept) |
| Update the repo / OpenCode version | `git pull && docker compose up -d --build` |
| Shell as the app user | `docker compose exec -u opencode opencode bash` |
| Log in a provider | `docker compose exec -u opencode opencode opencode auth login` |
| Back up OpenCode state | `docker compose exec -T opencode tar czf - -C /data xdg home > opencode-backup-$(date +%F).tgz` (contains `auth.json` secrets) |

All OpenCode state lives in the named volume `opencode_opencode_data`. It survives `down`, rebuilds and upgrades. **`docker compose down -v` deletes it**, along with Caddy's certificates.

Pi coding agent and other clients: use `$BASE/v1` as the base URL, exactly as with Railway (README section 9).
