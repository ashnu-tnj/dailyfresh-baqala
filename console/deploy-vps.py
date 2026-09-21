#!/usr/bin/env python3
"""Create or replace the dailyfresh-console Docker Compose project on the VPS.

    GH_PAT=<fine-grained, contents:read on this repo> \
    N8N_API_KEY=<n8n key> \
    python console/deploy-vps.py [--dry-run]

Docker builds straight from the private repo, so nothing has to be uploaded and
no SSH is involved. The build URL carries the token, which means it is written
into the Compose file on the VPS - scoped to one repo and read-only, but it is
on disk, so revoke it when you stop needing rebuilds.

Secrets for the container are passed as project environment variables rather
than baked into the Compose file, and CONSOLE_API_KEY / ADMIN_TOKEN are read
live from df_config so this script never holds a second copy of them.
"""
import json, os, sys, urllib.request, urllib.error

VM = int(os.environ.get("HOSTINGER_VM_ID", "1047573"))
PROJECT = "dailyfresh-console"
HOST = os.environ.get("CONSOLE_HOST", "dailyfresh.aflatus.com")
REPO = os.environ.get("CONSOLE_REPO", "github.com/ashnu-tnj/dailyfresh-baqala")
BRANCH = os.environ.get("CONSOLE_BRANCH", "main")
TRAEFIK_NET = os.environ.get("TRAEFIK_NETWORK", "n8n_default")

GH_PAT = os.environ.get("GH_PAT", "")
N8N_KEY = os.environ.get("N8N_API_KEY", "")
HOSTINGER_TOKEN = os.environ.get("HOSTINGER_API_TOKEN", "")
DRY = "--dry-run" in sys.argv

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "n8n"))


def n8n_config():
    """Read df_config so the console's secrets have exactly one home."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "cfgmod", os.path.join(HERE, "..", "n8n", "config.py"))
    cfg = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cfg)
    tid = cfg.table_id()
    s, b = cfg.call("GET", "/api/v1/data-tables/%s/rows?limit=200" % tid)
    out = {}
    for r in cfg.unwrap(b):
        if r.get("config_key"):
            out[r["config_key"]] = r.get("value")
    return out


COMPOSE = """services:
  dailyfresh-console:
    build: https://x-access-token:%(pat)s@%(repo)s.git#%(branch)s:console
    container_name: dailyfresh-console
    restart: unless-stopped
    environment:
      PORT: "8082"
      DATA_DIR: /app/data
      CONSOLE_API_URL: "${CONSOLE_API_URL}"
      CONSOLE_API_KEY: "${CONSOLE_API_KEY}"
      ADMIN_TOKEN: "${ADMIN_TOKEN}"
      SESSION_SECRET: "${SESSION_SECRET}"
      SESSION_DAYS: "30"
      VAPID_PUBLIC_KEY: "${VAPID_PUBLIC_KEY}"
      VAPID_PRIVATE_KEY: "${VAPID_PRIVATE_KEY}"
      VAPID_SUBJECT: "${VAPID_SUBJECT}"
    volumes:
      - ./data:/app/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.dailyfresh.rule=Host(`%(host)s`)"
      - "traefik.http.routers.dailyfresh.entrypoints=websecure"
      - "traefik.http.routers.dailyfresh.tls.certresolver=letsencrypt"
      - "traefik.http.services.dailyfresh.loadbalancer.server.port=8082"
    networks:
      - web

networks:
  web:
    external: true
    name: %(net)s
"""


def hostinger(method, path, body=None):
    req = urllib.request.Request("https://developers.hostinger.com" + path,
                                 data=json.dumps(body).encode() if body else None,
                                 method=method)
    req.add_header("Authorization", "Bearer " + HOSTINGER_TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode()[:600]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]


if __name__ == "__main__":
    if not GH_PAT:
        sys.exit("GH_PAT is not set (fine-grained token, Contents: Read on the repo)")
    if not N8N_KEY:
        sys.exit("N8N_API_KEY is not set - needed to read df_config")

    cfg = n8n_config()
    missing = [k for k in ("console_api_key", "console_admin_token") if not cfg.get(k)]
    if missing:
        sys.exit("df_config is missing: %s" % ", ".join(missing))

    import secrets
    env = {
        "CONSOLE_API_URL": os.environ.get(
            "CONSOLE_API_URL", "https://n8n.srv1047573.hstgr.cloud/webhook/df/console"),
        "CONSOLE_API_KEY": cfg["console_api_key"],
        "ADMIN_TOKEN": cfg["console_admin_token"],
        # Regenerated only when not supplied; changing it signs everyone out.
        "SESSION_SECRET": os.environ.get("SESSION_SECRET") or secrets.token_hex(32),
        "VAPID_PUBLIC_KEY": os.environ.get("VAPID_PUBLIC_KEY", ""),
        "VAPID_PRIVATE_KEY": os.environ.get("VAPID_PRIVATE_KEY", ""),
        "VAPID_SUBJECT": os.environ.get("VAPID_SUBJECT", "mailto:info@aflatus.com"),
    }
    if not env["VAPID_PUBLIC_KEY"] or not env["VAPID_PRIVATE_KEY"]:
        print("! VAPID keys not supplied - the console will run with push DISABLED")

    compose = COMPOSE % {"pat": GH_PAT, "repo": REPO, "branch": BRANCH,
                         "host": HOST, "net": TRAEFIK_NET}
    env_text = "\n".join("%s=%s" % (k, v) for k, v in env.items())

    if DRY:
        print(compose.replace(GH_PAT, "<TOKEN>"))
        print("--- environment ---")
        for k in env:
            print("%s=%s" % (k, "<set>" if env[k] else "<empty>"))
        sys.exit(0)

    if not HOSTINGER_TOKEN:
        sys.exit("HOSTINGER_API_TOKEN is not set")

    status, body = hostinger("POST", "/api/vps/v1/virtual-machines/%d/docker" % VM,
                             {"project_name": PROJECT, "content": compose,
                              "environment": env_text})
    print("deploy -> %s" % status)
    print(body if status >= 300 else "  project %s created; give it a minute to build" % PROJECT)
    print("  then: curl -s https://%s/api/health" % HOST)
