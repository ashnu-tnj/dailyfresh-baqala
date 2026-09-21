#!/usr/bin/env python3
"""Read or set a value in the df_config table.

    N8N_API_KEY=xxx python n8n/config.py                       list every key
    N8N_API_KEY=xxx python n8n/config.py phone_number_id       show one
    N8N_API_KEY=xxx python n8n/config.py delivery_fee 7        set one
    N8N_API_KEY=xxx python n8n/config.py access_token --stdin  set from stdin, never echoed

Use --stdin for secrets so the value never appears in shell history or in the
terminal. The n8n public API has no row PATCH; the working call is
POST /rows/upsert with a filter of {type, filters:[{columnName, condition, value}]}.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("N8N_BASE", "https://n8n.srv1047573.hstgr.cloud").rstrip("/")
KEY = os.environ.get("N8N_API_KEY", "")
TABLE = "df_config"


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


def table_id():
    s, b = call("GET", "/api/v1/data-tables")
    for t in unwrap(b):
        if t.get("name") == TABLE:
            return t["id"]
    sys.exit("df_config not found")


SECRETISH = ("token", "secret", "password", "key")


def show(rows, only=None):
    for r in sorted(rows, key=lambda x: str(x.get("config_key"))):
        k = r.get("config_key")
        if only and k != only:
            continue
        v = r.get("value")
        if v and any(s in str(k).lower() for s in SECRETISH):
            v = "<set, %d chars>" % len(str(v))
        print("  %-22s %s" % (k, "" if v in (None, "") else v))


def set_value(tid, key, value):
    # config_key must be in `data` as well as the filter: on the insert half of an
    # upsert the filter column is NOT written, which silently creates rows with a
    # null key that every reader then ignores.
    body = {"filter": {"type": "and",
                       "filters": [{"columnName": "config_key", "condition": "eq", "value": key}]},
            "data": {"config_key": key, "value": value}}
    s, b = call("POST", "/api/v1/data-tables/%s/rows/upsert" % tid, body)
    return s in (200, 201), (s, b)


if __name__ == "__main__":
    if not KEY:
        sys.exit("N8N_API_KEY is not set")
    tid = table_id()
    args = [a for a in sys.argv[1:] if a != "--stdin"]
    use_stdin = "--stdin" in sys.argv

    if not args:
        s, b = call("GET", "/api/v1/data-tables/%s/rows?limit=200" % tid)
        show(unwrap(b))
        sys.exit(0)

    key = args[0]
    if len(args) == 1 and not use_stdin:
        s, b = call("GET", "/api/v1/data-tables/%s/rows?limit=200" % tid)
        show(unwrap(b), only=key)
        sys.exit(0)

    value = sys.stdin.read().strip() if use_stdin else args[1]
    if not value:
        sys.exit("no value given")
    ok, detail = set_value(tid, key, value)
    if ok:
        hidden = any(s in key.lower() for s in SECRETISH)
        print("set %s = %s" % (key, ("<%d chars>" % len(value)) if hidden else value))
    else:
        sys.exit("failed to set %s: %s" % (key, detail))
