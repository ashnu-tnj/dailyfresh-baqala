# Deploying the DailyFresh console

Target: `https://dailyfresh.aflatus.com`, a container on VPS **1047573**
(`72.60.203.152`) behind the existing Traefik, on port **8082**.

Repo: `https://github.com/ashnu-tnj/dailyfresh-baqala` (**private**).

Two things must happen before it can serve traffic. Step 1 is yours either way.

---

## Step 1 — DNS (required, and only you can do it)

`aflatus.com` is **not** in the Hostinger account, so this has to be added at
whichever registrar holds the domain:

```
Type  A
Name  dailyfresh
Value 72.60.203.152
TTL   300
```

Traefik will not issue a certificate until this resolves. Check with:

```bash
nslookup dailyfresh.aflatus.com
```

---

## Step 2 — get the code onto the VPS

The repo is private, so the build needs read access. Pick whichever you prefer.

### Route A — you run three commands (no token leaves your hands)

In Hostinger's browser terminal for the VPS:

```bash
mkdir -p /docker/dailyfresh && cd /docker/dailyfresh
git clone https://github.com/ashnu-tnj/dailyfresh-baqala.git .
cp console/.env.example console/.env && nano console/.env   # fill in the five values below
cd console && docker compose up -d --build
```

Git will prompt for your GitHub username and a personal access token once; after
that `git pull && docker compose up -d --build` is all a redeploy takes.

### Route B — give me a read-only token and I deploy through the Hostinger API

Create a **fine-grained** personal access token:
GitHub → Settings → Developer settings → Fine-grained tokens →
*Only select repositories* → `dailyfresh-baqala` → Repository permissions →
**Contents: Read-only** → short expiry.

Give me that token and I'll create the Compose project remotely. Be aware of the
trade-off: the build URL containing that token is stored in the Compose file on
the VPS. It is scoped to one repo, read-only, and revocable — but it does sit on
disk. You can revoke it immediately after the first build if you would rather
rebuild manually later.

---

## The five values in `console/.env`

| Key | Where it comes from |
|---|---|
| `CONSOLE_API_URL` | `https://n8n.srv1047573.hstgr.cloud/webhook/df/console` |
| `CONSOLE_API_KEY` | `df_config.console_api_key` — `python n8n/config.py console_api_key` |
| `ADMIN_TOKEN` | `df_config.console_admin_token` |
| `SESSION_SECRET` | any long random string: `openssl rand -hex 32` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npm run vapid`, once — regenerating signs every device out of notifications |

Leave `BASE_PATH` empty and do **not** set `INSECURE_COOKIE` in production; the
session cookie must stay `Secure`.

---

## Step 3 — point the bot at it

Once the console answers, tell the bot where to push:

```bash
N8N_API_KEY=... python n8n/config.py console_notify_url https://dailyfresh.aflatus.com/api/notify
```

Until this is set, the bot's `Notify Order` and `Notify Staff` nodes fail with
*"URL parameter cannot be empty"* and continue — orders are still written, staff
just get no push.

---

## Verify

```bash
curl -s https://dailyfresh.aflatus.com/api/health
# {"ok":true,"push":true,"subscriptions":0,...}
```

Then on the shop's phone:

1. Open the site, sign in with the shop number — the 6-digit code arrives on
   WhatsApp. Only `df_config.owner_phone` can receive one.
2. **Add to Home Screen**, open it from there, Settings → **Enable** notifications.
   Web Push on iOS only works from an installed PWA, not a browser tab.
3. Settings → *Send a test notification*.
4. Place an order from a customer handset and confirm the push lands and the
   order appears under **Orders**.

## Redeploying

```bash
cd /docker/dailyfresh && git pull
cd console && docker compose up -d --build
```

`console/data/` holds the push subscriptions and is bind-mounted, so it survives
rebuilds. Do not delete it unless you want every device to re-subscribe.
