#!/usr/bin/env python3
"""Read or delete rows in a DailyFresh data table.

    N8N_API_KEY=xxx python n8n/rows.py df_orders
    N8N_API_KEY=xxx python n8n/rows.py df_sessions --cols phone,current_step
    N8N_API_KEY=xxx python n8n/rows.py df_sessions --delete-phone +971500000099
"""
import json, os, sys, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get("N8N_BASE", "https://n8n.srv1047573.hstgr.cloud").rstrip("/")
KEY = os.environ.get("N8N_API_KEY", "")


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method=method)
    req.add_header("X-N8N-API-KEY", KEY)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def unwrap(b):
    while isinstance(b, dict) and "data" in b:
        b = b["data"]
    return b if isinstance(b, list) else []


def table_id(name):
    s, b = call("GET", "/api/v1/data-tables")
    for t in unwrap(b):
        if t.get("name") == name:
            return t["id"]
    sys.exit("No such table: " + name)


def fetch(tid):
    # n8n has used different paging params across versions; try each.
    for q in ["?limit=200", "?take=200", ""]:
        s, b = call("GET", "/api/v1/data-tables/%s/rows%s" % (tid, q))
        if s == 200:
            return unwrap(b)
    sys.exit("Could not read rows (last status %s): %s" % (s, b))


if __name__ == "__main__":
    if not KEY:
        sys.exit("N8N_API_KEY is not set")
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    name = sys.argv[1]
    tid = table_id(name)

    if "--delete-phone" in sys.argv:
        want = sys.argv[sys.argv.index("--delete-phone") + 1]
        digits = "".join(c for c in want if c.isdigit())
        rows = fetch(tid)
        killed = 0
        for r in rows:
            hay = "".join(c for c in json.dumps(r) if c.isdigit())
            if digits and digits in hay:
                s, b = call("DELETE", "/api/v1/data-tables/%s/rows?filter=%s" % (
                    tid, urllib.parse.quote(json.dumps({"id": r["id"]}))))
                if s in (200, 204):
                    killed += 1
        print("%s: deleted %d row(s) matching %s" % (name, killed, want))
        sys.exit(0)

    cols = None
    if "--cols" in sys.argv:
        cols = sys.argv[sys.argv.index("--cols") + 1].split(",")
    rows = fetch(tid)
    print("%s: %d rows" % (name, len(rows)))
    for r in rows:
        if cols:
            print("  " + json.dumps({c: r.get(c) for c in cols}, ensure_ascii=False))
        else:
            slim = {k: v for k, v in r.items() if v not in ("", None)}
            print("  " + json.dumps(slim, ensure_ascii=False)[:400])
