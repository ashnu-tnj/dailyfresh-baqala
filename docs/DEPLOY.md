# Deploying the DailyFresh console

## How it is actually deployed (learned the hard way, 2026-09-21)

Three things differ from what the plan assumed:

1. **The Hostinger Docker API cannot build from a git context.** A compose with
   `build: https://github.com/...#main:console` returns *success* in 12 seconds
   and creates no container, with no build logs. Only `image:` works. So the
   container runs stock `node:20-alpine` and clones the repo at start-up.
2. **Traefik's certresolver here is `mytlschallenge`, not `letsencrypt`.** With
   the wrong name Traefik still routes (http 301 to https) but serves its own
   self-signed cert, so the site looks broken in a way that has nothing to do
   with DNS. The name comes from n8n's official Traefik compose, which is what
   this Hostinger template ships.
3. **The container is on the `n8n_default` network** and is routed purely by
   labels - it publishes no ports.

The start command clones into `/app/src/repo` when the repo is reachable and
otherwise keeps the copy already on disk, so a restart never takes the console
down just because the repo is private. The log line tells you which happened:

```
source updated from git
repo not reachable - keeping the copy already on disk
```

**Consequence: with the repo private, a restart will not pick up new commits.**
Give the container a way to read the repo (see Step 2) or the deployed code
silently stays on whatever was last cloned.

## Meta app URLs (configured 2026-09-21)

All four live on the console container, so they share the domain and certificate.

| Meta field | URL | State |
|---|---|---|
| Embedded Signup | `https://dailyfresh.aflatus.com/connect` | live — branded page that hands off to Meta's hosted flow (`config_id 1617780349756737`, featureType `whatsapp_business_app_onboarding`, i.e. Coexistence) |
| Valid OAuth Redirect URI | `https://dailyfresh.aflatus.com/connect/callback` | saved, and Meta's own validator says *"This is a valid redirect URI for this application"* |
| Deauthorize callback | `https://dailyfresh.aflatus.com/deauthorize` | saved |
| Data Deletion Request | `https://dailyfresh.aflatus.com/datadeletion` | saved (callback), and the Basic-settings instructions URL points at the same page |
| Terms of Service | `https://dailyfresh.aflatus.com/terms` | **live, but not yet saved in the app** — App Review needs it, see `APP-REVIEW.md` |

Also set: **Login with the JavaScript SDK = Yes** and **Allowed Domains for the
JavaScript SDK = `https://dailyfresh.aflatus.com/`**. Embedded Signup will not
run without both.

`META_APP_SECRET` is set, so `signed_request` verification is **enabled** and
tested in production: a correctly signed callback returns 200 and a tampered one
returns 400. Check any time with:

```bash
curl -s https://dailyfresh.aflatus.com/meta/health
# signed_request_verification: enabled | embedded_signup: meta-hosted
```

The app secret lives in two places on purpose: the container has it to verify
`signed_request`, and `df_config.meta_app_secret` has it so n8n can do the code
exchange. n8n is the only one that ever handles a token.

**Embedded Signup uses Meta's hosted landing page.** `/connect` keeps our own
explanation and then hands off, rather than driving the JS SDK ourselves — no SDK
to load, nothing for a popup blocker to eat, and it is the path Meta supports.
The JS SDK version is still in the code as a fallback if `META_HOSTED_SIGNUP_URL`
is ever unset. Meta returns the exchange code to `/connect/callback`.

**Onboarding is end to end.** `/connect/callback` hands the code to the Console
API's `onboard` action, which:

1. swaps the code for a business token (app secret never leaves n8n),
2. asks `debug_token` which WhatsApp Business Account the token is scoped to,
3. reads that account's phone number,
4. **subscribes this app to that WABA's webhooks** — skip this and the bot looks
   healthy and receives nothing,
5. writes `access_token`, `waba_id` and `phone_number_id` into `df_config`.

Failures are reported to the shop in plain words. Verified against Meta with a
deliberately bad code: *"That signup link was already used or has expired."*
Coexistence commonly reports no phone number until the owner finishes on their
handset, and that case says exactly that.

## Live now

| | |
|---|---|
| Console | https://dailyfresh.aflatus.com |
| Compose project | `dailyfresh-console` on VM 1047573 |
| Source on disk | `/docker/dailyfresh-console/src/repo` |
| Push subscriptions | `/docker/dailyfresh-console/data` (bind-mounted, survives rebuilds) |


Target: `https://dailyfresh.aflatus.com`, a container on VPS **1047573**
(`72.60.203.152`) behind the existing Traefik, on port **8082**.

Repo: `https://github.com/ashnu-tnj/dailyfresh-baqala` (**public** for now, at the
owner's instruction; when it goes private again the container can no longer
re-clone and will keep running the copy already on disk).

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
