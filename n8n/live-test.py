#!/usr/bin/env python3
"""Drive a conversation through the DEPLOYED webhook and report what the bot did.

    N8N_API_KEY=xxx python n8n/live-test.py [--phone 971500000001] [--clean]

This exercises the parts the local suite cannot: Meta payload shapes, the n8n
wiring, the data-table reads and writes, and the Ollama branch. It reads each
execution back over the API and prints the reply the bot built, so a failure is
visible even though no real WhatsApp message can be delivered from a test
phone_number_id.

--clean deletes the rows this phone number left behind.
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get("N8N_BASE", "https://n8n.srv1047573.hstgr.cloud").rstrip("/")
KEY = os.environ.get("N8N_API_KEY", "")
WF = os.environ.get("DF_WORKFLOW_ID", "f5rSxsEUoW4Rif9z")
HOOK = BASE + "/webhook/dailyfresh/wa"

phone = "971500000001"
for i, a in enumerate(sys.argv):
    if a == "--phone" and i + 1 < len(sys.argv):
        phone = sys.argv[i + 1]
CLEAN = "--clean" in sys.argv


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 method=method)
    req.add_header("X-N8N-API-KEY", KEY)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def post_hook(message):
    payload = {"object": "whatsapp_business_account", "entry": [{"id": "WABA_TEST", "changes": [
        {"field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": "15551234567", "phone_number_id": "TESTPNID"},
            "contacts": [{"profile": {"name": "Ahmed"}, "wa_id": phone}],
            "messages": [message]}}]}]}
    req = urllib.request.Request(HOOK, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


seq = [0]


def mid():
    seq[0] += 1
    return "wamid.LIVE%d.%d" % (int(time.time()), seq[0])


def text(body):
    return {"from": phone, "id": mid(), "timestamp": str(int(time.time())), "type": "text",
            "text": {"body": body}}


def tap(rid, title="", kind="button"):
    inner = {"id": rid, "title": title or rid}
    inter = {"type": "button_reply", "button_reply": inner} if kind == "button" \
        else {"type": "list_reply", "list_reply": inner}
    return {"from": phone, "id": mid(), "timestamp": str(int(time.time())),
            "type": "interactive", "interactive": inter}


def location(lat, lng):
    return {"from": phone, "id": mid(), "timestamp": str(int(time.time())), "type": "location",
            "location": {"latitude": lat, "longitude": lng}}


def last_execution():
    s, b = api("GET", "/api/v1/executions?workflowId=%s&limit=1&includeData=true" % WF)
    if s != 200 or not b.get("data"):
        return None
    return b["data"][0]


def describe(label):
    e = last_execution()
    if not e:
        print("  %-28s (no execution found)" % label)
        return
    rd = (e.get("data") or {}).get("resultData") or {}
    run = rd.get("runData") or {}
    if "Engine" not in run:
        print("  %-28s !! never reached the Engine (last node: %s)" % (label, rd.get("lastNodeExecuted")))
        return
    try:
        j = run["Engine"][0]["data"]["main"][0][0]["json"]
    except Exception:
        print("  %-28s !! Engine produced nothing" % label)
        return
    if j.get("duplicate"):
        print("  %-28s duplicate ignored" % label)
        return
    s = j.get("send")
    act = (j.get("event") or {}).get("action")
    if not s:
        print("  %-28s [silent]  event=%s" % (label, act))
        return
    bits = []
    if s.get("buttons"):
        bits.append("buttons: " + " | ".join(b["title"] for b in s["buttons"]))
    for sec in (s.get("sections") or []):
        bits.append("list[%s]: %s" % (sec["title"], " / ".join(r["title"] for r in sec["rows"])))
    head = (s.get("body") or "").replace("\n", " ")[:78]
    print("  %-28s (%s) %s" % (label, act, head))
    for b in bits:
        print("       %s" % b[:110])
    errs = [n for n, r in run.items() if r and r[0].get("error") and n != "Send Reply"]
    if errs:
        print("       !! node errors: %s" % ", ".join(errs))


def step(label, message, wait=2.5):
    post_hook(message)
    time.sleep(wait)
    describe(label)


def clean():
    s, b = api("GET", "/api/v1/data-tables")
    tables = {t["name"]: t["id"] for t in (b.get("data") if isinstance(b, dict) else b)}
    plus = "+" + phone
    for name, col in [("df_sessions", "phone"), ("df_customers", "phone"),
                      ("df_orders", "customer_phone"), ("df_handoffs", "customer_phone")]:
        tid = tables.get(name)
        if not tid:
            continue
        s, b = api("GET", "/api/v1/data-tables/%s/rows?take=200" % tid)
        rows = (b.get("data") if isinstance(b, dict) else b) or []
        ids = [r["id"] for r in rows if str(r.get(col, "")) in (plus, phone)]
        for rid in ids:
            api("DELETE", "/api/v1/data-tables/%s/rows?filter=%s" % (
                tid, urllib.parse.quote(json.dumps({"id": rid}))))
        print("  cleaned %-14s %d row(s)" % (name, len(ids)))


if __name__ == "__main__":
    if not KEY:
        sys.exit("N8N_API_KEY is not set")
    if CLEAN:
        import urllib.parse
        clean()
        sys.exit(0)

    print("driving %s through %s\n" % (phone, HOOK))
    step("1 greeting", text("hi"))
    step("2 tap Order Now", tap("order_now", "Order Now"))
    step("3 share location", location(25.31, 55.42))
    step("4 type address", text("Villa 12, Al Nahda Building, Street 7, near Sahara Centre"))
    step("5 confirm address", tap("addr_ok", "Yes, correct"))
    step("6 use profile name", tap("name_ok", "Use Ahmed"))
    step("7 open Vegetables", tap("cat:0", "Vegetables", "list"))
    step("8 open Tomatoes", tap("grp:TOM", "Tomatoes", "list"))
    step("9 pick 1 kg", tap("pk:TOM1K", "1 kg AED 6.50"))
    step("10 quantity 2", tap("q:2", "2"))
    step("11 typed local name", text("2 kg thakkali and 1 bunch kothmir"), wait=12)
    step("12 view basket", tap("cart", "View basket"))
    # Cross the minimum order value so the confirm path is actually exercised.
    step("13 add rice", tap("add_more", "Add more"))
    step("14 groceries", tap("cat:5", "Groceries", "list"))
    step("15 pick rice", tap("grp:RIC", "Basmati Rice", "list"))
    step("16 one bag", tap("q:1", "1"))
    step("17 confirm order", tap("confirm", "Confirm order"))
    step("18 greeting mid-chat", text("hi"))
    step("19 tap staff", tap("staff", "Talk to Staff"))
    step("20 message while handed off", text("do you have organic carrots?"))
    step("21 resume", tap("resume", "Back to ordering"))
    print("\nrun with --clean to remove this phone number's rows")
