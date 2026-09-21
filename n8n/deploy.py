#!/usr/bin/env python3
"""Deploy DailyFresh to the n8n instance over its public API.

    N8N_API_KEY=<key> python n8n/deploy.py tables     create the df_* data tables
    N8N_API_KEY=<key> python n8n/deploy.py seed       load df_config + df_catalog rows
    N8N_API_KEY=<key> python n8n/deploy.py workflow   create/update the bot workflow
    N8N_API_KEY=<key> python n8n/deploy.py all        all three, in order
    N8N_API_KEY=<key> python n8n/deploy.py probe      just show what the API exposes

Everything is idempotent: tables that exist are left alone, config and catalogue
rows are matched on their key column, and the workflow is updated in place when a
workflow of the same name already exists (so its webhook URL never changes).

The workflow is NOT activated automatically - activate it once the Meta webhook
is pointed at it.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("N8N_BASE", "https://n8n.srv1047573.hstgr.cloud").rstrip("/")
KEY = os.environ.get("N8N_API_KEY", "")
PROJECT = os.environ.get("N8N_PROJECT_ID", "7E469OiRfz4pzPmU")

HERE = os.path.dirname(os.path.abspath(__file__))
WF_NAME = "DailyFresh - WhatsApp Bot (Baqala)"


def call(method, path, body=None, quiet=False):
    url = path if path.startswith("http") else BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-N8N-API-KEY", KEY)
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:500]
        if not quiet:
            pass
        return e.code, detail
    except Exception as e:                       # network, TLS, timeout
        return 0, str(e)


def rows_of(payload):
    if isinstance(payload, dict):
        return payload.get("data", payload.get("items", []))
    return payload or []


# --------------------------------------------------------------- endpoints
DT_PATHS = ["/api/v1/projects/%s/data-tables" % PROJECT, "/api/v1/data-tables"]


def data_table_base():
    for p in DT_PATHS:
        status, body = call("GET", p, quiet=True)
        if status == 200:
            return p, rows_of(body)
    return None, []


def probe():
    print("base: " + BASE)
    for p in ["/api/v1/workflows?limit=1", "/api/v1/credentials/schema/httpHeaderAuth"] + DT_PATHS:
        s, b = call("GET", p, quiet=True)
        note = ""
        if s == 200 and "data-tables" in p:
            note = "  (%d tables)" % len(rows_of(b))
        print("  %-52s -> %s%s" % (p, s, note))


# --------------------------------------------------------------- tables
def cmd_tables():
    defs = json.load(open(os.path.join(HERE, "tables.json"), encoding="utf-8"))
    path, existing = data_table_base()
    if not path:
        sys.exit("No data-tables endpoint responded. Tried: " + ", ".join(DT_PATHS))
    print("endpoint: " + path)
    have = {t.get("name"): t.get("id") for t in existing if isinstance(t, dict)}
    made = {}
    for name, cols in defs.items():
        if name in have:
            print("  = %-14s exists (id=%s)" % (name, have[name]))
            made[name] = have[name]
            continue
        status, body = call("POST", path, {"name": name, "columns": cols})
        if status in (200, 201):
            tid = body.get("id") if isinstance(body, dict) else (body.get("data", {}) or {}).get("id")
            made[name] = tid
            print("  + %-14s created, %2d columns (id=%s)" % (name, len(cols), tid))
        else:
            print("  ! %-14s FAILED %s %s" % (name, status, body))
    return path, made


# --------------------------------------------------------------- seed rows
def table_id(path, name):
    _, existing = data_table_base()
    for t in existing:
        if isinstance(t, dict) and t.get("name") == name:
            return t.get("id")
    return None


def row_count(path, tid):
    """Number of rows, or None if the table could not be read.

    Never return 0 on a failed read - the seed guard uses this, and a wrong 0
    duplicates every row in the table.
    """
    for q in ("?limit=200", "?take=200", ""):
        s, b = call("GET", "%s/%s/rows%s" % (path, tid, q), quiet=True)
        if s == 200:
            return len(rows_of(b))
    return None


def insert_rows(path, tid, rows, label):
    ok = 0
    for r in rows:
        status, body = call("POST", "%s/%s/insert" % (path, tid), {"data": [r]}, quiet=True)
        if status not in (200, 201):
            status, body = call("POST", "%s/%s/rows" % (path, tid), {"data": [r]}, quiet=True)
        if status in (200, 201):
            ok += 1
        elif ok == 0:
            print("  ! %s insert failed: %s %s" % (label, status, str(body)[:200]))
            return 0
    print("  + %-14s %d rows loaded" % (label, ok))
    return ok


def cmd_seed():
    path, _ = data_table_base()
    if not path:
        sys.exit("data-tables endpoint not reachable")

    cfg_rows = json.load(open(os.path.join(HERE, "seed", "df_config.json"), encoding="utf-8"))["rows"]
    cat_rows = json.load(open(os.path.join(HERE, "seed", "df_catalog.seed.json"), encoding="utf-8"))["rows"]

    cid = table_id(path, "df_config")
    if cid:
        n = row_count(path, cid)
        if n is None:
            print("  ! df_config could not be read - refusing to seed")
        elif n > 0:
            print("  = df_config already has %d rows, skipping" % n)
        else:
            insert_rows(path, cid, cfg_rows, "df_config")
    else:
        print("  ! df_config not found - run 'tables' first")

    tid = table_id(path, "df_catalog")
    if tid:
        n = row_count(path, tid)
        if n is None:
            print("  ! df_catalog could not be read - refusing to seed")
        elif n > 0:
            print("  = df_catalog already has %d rows, skipping" % n)
        else:
            stamped = []
            for r in cat_rows:
                c = dict(r)
                c["updated_by"] = "seed"
                stamped.append(c)
            insert_rows(path, tid, stamped, "df_catalog")
    else:
        print("  ! df_catalog not found - run 'tables' first")


# --------------------------------------------------------------- workflow
def cmd_workflow():
    built = os.path.join(HERE, "build", "dailyfresh-bot.workflow.json")
    if not os.path.exists(built):
        sys.exit("Build it first:  python n8n/build-workflow.py")
    wf = json.load(open(built, encoding="utf-8"))

    status, body = call("GET", "/api/v1/workflows?limit=250")
    if status != 200:
        sys.exit("Cannot list workflows: %s %s" % (status, body))
    found = None
    for w in rows_of(body):
        if w.get("name") == WF_NAME:
            found = w
            break

    payload = {"name": wf["name"], "nodes": wf["nodes"],
               "connections": wf["connections"], "settings": wf["settings"]}

    if found:
        status, body = call("PUT", "/api/v1/workflows/%s" % found["id"], payload)
        verb, wid = "updated", found["id"]
    else:
        status, body = call("POST", "/api/v1/workflows", payload)
        wid = (body or {}).get("id") if isinstance(body, dict) else None
        verb = "created"

    if status in (200, 201):
        print("  + workflow %s: %s (%d nodes)" % (verb, wid, len(wf["nodes"])))
        print("    webhook:  %s/webhook/dailyfresh/wa" % BASE)
        print("    activate it in the UI once the Meta callback URL is set")
    else:
        print("  ! workflow %s FAILED %s %s" % (verb, status, str(body)[:400]))


def cmd_reset():
    """Clear conversation/order data, keeping config and the catalogue.

    The n8n public API has no row-delete (it answers 405), so the only way to
    empty a table over the API is to drop and recreate it. Safe for these four -
    they hold nothing that is not reproducible.
    """
    defs = json.load(open(os.path.join(HERE, "tables.json"), encoding="utf-8"))
    transient = ["df_sessions", "df_customers", "df_handoffs", "df_orders"]
    path, existing = data_table_base()
    if not path:
        sys.exit("data-tables endpoint not reachable")
    have = {t["name"]: t["id"] for t in existing if isinstance(t, dict)}
    for name in transient:
        tid = have.get(name)
        if not tid:
            print("  ? %-14s missing" % name)
            continue
        s, b = call("DELETE", "%s/%s" % (path, tid))
        if s not in (200, 204):
            print("  ! %-14s drop refused %s %s" % (name, s, str(b)[:120]))
            continue
        s2, _ = call("POST", path, {"name": name, "columns": defs[name]})
        print("  ~ %-14s emptied (%s)" % (name, "ok" if s2 in (200, 201) else "RECREATE FAILED " + str(s2)))


CMDS = {"probe": probe, "tables": cmd_tables, "seed": cmd_seed,
        "workflow": cmd_workflow, "reset": cmd_reset}

if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if not KEY:
        sys.exit("N8N_API_KEY is not set.\n"
                 "Create one in n8n: Settings -> n8n API -> Create an API key.")
    if what == "all":
        cmd_tables(); cmd_seed(); cmd_workflow()
    elif what in CMDS:
        CMDS[what]()
    else:
        sys.exit("Unknown command %r. One of: %s, all" % (what, ", ".join(CMDS)))
