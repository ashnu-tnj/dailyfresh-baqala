#!/usr/bin/env python3
"""Generate the DailyFresh Console API workflow.

One authenticated webhook the PWA talks to, so the container never holds n8n
credentials and can only do the four things below:

  state          shop settings + recent orders + open handoffs + catalogue
  update         order status | item price/stock/listing | a config key | close a handoff
  login_request  send a 6-digit code over WhatsApp, owner number only
  login_verify   check that code

Writes are read-merge-upsert rather than a bare upsert: a price-only edit must
not blank the item's name.

    python n8n/build-console-api.py -> n8n/build/dailyfresh-console.workflow.json
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wfkit import (Builder, IF, CODE, WEBHOOK, RESPOND, HTTP, DATATABLE, SWITCH,
                   cond_str, cond_bool, dt_get, dt_upsert, respond_json)

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
PATH = "df/console"
GRAPH_VERSION = "v21.0"

b = Builder()

b.node("Console Webhook", WEBHOOK,
       {"httpMethod": "POST", "path": PATH, "responseMode": "responseNode",
        "options": {"allowedOrigins": "*"}}, -600, 300, webhookId="dailyfresh-console-hook")

b.node("Read Config", DATATABLE, dt_get("df_config"), -400, 300,
       alwaysOutputData=True, executeOnce=True)

AUTH_JS = r"""
// The shared key lives in df_config, so it can be rotated without redeploying
// either the workflow or the container.
const body = $('Console Webhook').first().json.body || {};
const cfg = {};
// Read by node name, not $input: this node is executeOnce, which hands it only
// the first of the config rows.
for (const i of $('Read Config').all()) {
  const r = i.json;
  if (r && r.config_key) cfg[r.config_key] = r.value;
}
const expected = String(cfg.console_api_key || '');
const given = String(body.key || '');
// Constant-time-ish compare: same length check first, then char by char.
let ok = expected.length > 0 && given.length === expected.length;
if (ok) {
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  ok = diff === 0;
}
return [{ json: { ok: ok, action: String(body.action || ''), body: body, cfg: cfg } }];
"""
b.node("Auth & Route", CODE, {"jsCode": AUTH_JS}, -200, 300, executeOnce=True)

b.node("Authorized?", IF, {"conditions": cond_bool("={{ $json.ok }}"), "options": {}}, 0, 300)
b.node("Respond 401", RESPOND, respond_json('={{ JSON.stringify({ok:false,error:"unauthorized"}) }}', 401), 200, 120)

b.node("Route Action", SWITCH,
       {"rules": {"values": [
           {"outputKey": "state", "conditions": cond_str("={{ $json.action }}", "equals", "state"), "renameOutput": True},
           {"outputKey": "update", "conditions": cond_str("={{ $json.action }}", "equals", "update"), "renameOutput": True},
           {"outputKey": "login_request", "conditions": cond_str("={{ $json.action }}", "equals", "login_request"), "renameOutput": True},
           {"outputKey": "login_verify", "conditions": cond_str("={{ $json.action }}", "equals", "login_verify"), "renameOutput": True},
       ]}, "options": {"fallbackOutput": "extra"}}, 200, 400)
b.node("Respond 400", RESPOND, respond_json('={{ JSON.stringify({ok:false,error:"unknown action"}) }}', 400), 420, 900)

# ------------------------------------------------------------------ state
b.node("Read Orders", DATATABLE, dt_get("df_orders"), 420, 60, alwaysOutputData=True, executeOnce=True)
b.node("Read Handoffs", DATATABLE, dt_get("df_handoffs"), 620, 60, alwaysOutputData=True, executeOnce=True)
b.node("Read Catalog", DATATABLE, dt_get("df_catalog"), 820, 60, alwaysOutputData=True, executeOnce=True)

STATE_JS = r"""
const cfg = $('Auth & Route').first().json.cfg || {};
const rows = (name, key) => $(name).all().map(i => i.json).filter(r => r && r[key]);

const orders = rows('Read Orders', 'order_id');
orders.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

const num = (k, d) => { const v = parseFloat(cfg[k]); return isFinite(v) ? v : d; };
const bool = (k, d) => (cfg[k] === undefined || cfg[k] === '') ? d
  : String(cfg[k]).toLowerCase() !== 'false' && String(cfg[k]) !== '0';

return [{ json: {
  ok: true,
  shop: {
    business_name: cfg.business_name || 'Shop',
    currency: cfg.currency || 'AED',
    accepting_orders: bool('accepting_orders', true),
    delivery_fee: num('delivery_fee', 0),
    free_delivery_over: num('free_delivery_over', 0),
    min_order_value: num('min_order_value', 0),
    delivery_radius_km: num('delivery_radius_km', 0),
    open_time: cfg.open_time || '', close_time: cfg.close_time || '',
    support_phone: cfg.support_phone || ''
  },
  orders: orders.slice(0, 120).map(o => ({
    order_id: o.order_id, created_at: o.created_at, status: o.status || 'new',
    customer_name: o.customer_name, customer_phone: o.customer_phone,
    address_text: o.address_text, map_link: o.map_link,
    items_text: o.items_text, total_items: o.total_items,
    subtotal: o.subtotal, delivery_fee: o.delivery_fee, total: o.total,
    payment_mode: o.payment_mode, accepted_by: o.accepted_by, notes: o.notes
  })),
  handoffs: rows('Read Handoffs', 'handoff_id')
    .filter(h => String(h.status || '') !== 'closed')
    .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''))),
  catalog: rows('Read Catalog', 'item_code').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
} }];
"""
b.node("Build State", CODE, {"jsCode": STATE_JS}, 1020, 60, executeOnce=True)
b.node("Respond State", RESPOND, respond_json(), 1220, 60)

# ------------------------------------------------------------------ update
UPDATE_JS = r"""
const b = $('Auth & Route').first().json.body || {};
const target = String(b.target || '');
const allowed = ['order', 'item', 'config', 'handoff'];
if (allowed.indexOf(target) < 0) return [{ json: { target: 'bad', error: 'unknown target' } }];

const key = target === 'order' ? String(b.order_id || '')
          : target === 'item' ? String(b.item_code || '')
          : target === 'config' ? String(b.config_key || '')
          : String(b.handoff_id || '');
if (!key) return [{ json: { target: 'bad', error: 'missing key' } }];

// Only these fields may ever be written from the console.
const patch = {};
if (target === 'order') {
  const ok = ['new', 'accepted', 'rejected', 'delivered'];
  if (ok.indexOf(String(b.status)) < 0) return [{ json: { target: 'bad', error: 'bad status' } }];
  patch.status = String(b.status);
  patch.accepted_by = String(b.by || 'console').slice(0, 60);
  if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 500);
} else if (target === 'item') {
  if (b.price !== undefined) {
    const p = Number(b.price);
    if (!isFinite(p) || p <= 0) return [{ json: { target: 'bad', error: 'bad price' } }];
    patch.price = Math.round(p * 100) / 100;
  }
  if (b.out_of_stock !== undefined) patch.out_of_stock = !!b.out_of_stock;
  if (b.listed !== undefined) patch.listed = !!b.listed;
  patch.updated_at = new Date().toISOString();
  patch.updated_by = 'console';
} else if (target === 'config') {
  const allowedKeys = ['accepting_orders', 'delivery_fee', 'min_order_value',
                       'free_delivery_over', 'open_time', 'close_time', 'delivery_eta'];
  if (allowedKeys.indexOf(key) < 0) return [{ json: { target: 'bad', error: 'key not editable' } }];
  patch.value = String(b.value);
} else {
  patch.status = 'closed';
  patch.closed_at = new Date().toISOString();
}
return [{ json: { target: target, key: key, patch: patch } }];
"""
b.node("Build Update", CODE, {"jsCode": UPDATE_JS}, 420, 400, executeOnce=True)

b.node("Route Target", SWITCH,
       {"rules": {"values": [
           {"outputKey": "order", "conditions": cond_str("={{ $json.target }}", "equals", "order"), "renameOutput": True},
           {"outputKey": "item", "conditions": cond_str("={{ $json.target }}", "equals", "item"), "renameOutput": True},
           {"outputKey": "config", "conditions": cond_str("={{ $json.target }}", "equals", "config"), "renameOutput": True},
           {"outputKey": "handoff", "conditions": cond_str("={{ $json.target }}", "equals", "handoff"), "renameOutput": True},
       ]}, "options": {"fallbackOutput": "extra"}}, 620, 400)

# Read-merge-upsert: never blank a field the console did not touch.
MERGE_JS = r"""
const u = $('Build Update').first().json;
const existing = $input.all().map(i => i.json).filter(r => r && Object.keys(r).length);  // single-row read, safe
const base = existing.length ? existing[0] : {};
const row = Object.assign({}, base, u.patch);
delete row.id; delete row.createdAt; delete row.updatedAt;
return [{ json: row }];
"""
for i, (label, table, col, y) in enumerate([
        ("Order Row", "df_orders", "order_id", 240),
        ("Item Row", "df_catalog", "item_code", 400),
        ("Config Row", "df_config", "config_key", 560),
        ("Handoff Row", "df_handoffs", "handoff_id", 720)]):
    b.node("Read %s" % label, DATATABLE,
           dt_get(table, [{"keyName": col, "condition": "eq",
                           "keyValue": "={{ $('Build Update').first().json.key }}"}],
                  return_all=False), 840, y, alwaysOutputData=True, executeOnce=True)
    b.node("Merge %s" % label, CODE, {"jsCode": MERGE_JS}, 1040, y, executeOnce=True)
    b.node("Write %s" % label, DATATABLE, dt_upsert(table, col), 1240, y,
           executeOnce=True, onError="continueRegularOutput")
    b.link("Route Target", "Read %s" % label, i)
    b.link("Read %s" % label, "Merge %s" % label)
    b.link("Merge %s" % label, "Write %s" % label)
    b.link("Write %s" % label, "Respond Update")

b.node("Respond Update", RESPOND,
       respond_json('={{ JSON.stringify({ok:true, target:$(\'Build Update\').first().json.target}) }}'),
       1460, 400)
# A rejected update should say WHY, not reuse the router's "unknown action".
b.node("Respond Bad Update", RESPOND,
       respond_json("={{ JSON.stringify({ok:false, error: $('Build Update').first().json.error || 'rejected'}) }}", 400),
       1460, 880)
b.link("Route Target", "Respond Bad Update", 4)

# ------------------------------------------------------------------ login
MAKE_CODE_JS = r"""
// Only the shop's own number may ever be sent a login code.
const r = $('Auth & Route').first().json;
const cfg = r.cfg || {};
const digits = s => String(s == null ? '' : s).replace(/[^0-9]/g, '');
const want = digits(cfg.owner_phone);
const got = digits((r.body || {}).phone);
if (!want || want !== got) {
  return [{ json: { allowed: false, reason: 'not the registered number' } }];
}
const code = String(Math.floor(100000 + Math.random() * 900000));
return [{ json: {
  allowed: true,
  phone: '+' + want,
  code: code,
  expires_at: Date.now() + 10 * 60 * 1000,
  used: false,
  attempts: 0,
  created_at: new Date().toISOString(),
  graph_url: 'https://graph.facebook.com/' + (cfg.graph_version || '%s') + '/' +
             (cfg.phone_number_id || '') + '/messages',
  token: cfg.access_token || '',
  business_name: cfg.business_name || 'the shop'
} }];
""" % GRAPH_VERSION
b.node("Make Login Code", CODE, {"jsCode": MAKE_CODE_JS}, 420, 1100, executeOnce=True)
b.node("Allowed?", IF, {"conditions": cond_bool("={{ $json.allowed }}"), "options": {}}, 620, 1100)
b.node("Respond Login Denied", RESPOND,
       respond_json('={{ JSON.stringify({ok:false,error:"not the registered number"}) }}', 403), 840, 1260)

b.node("Store Code", DATATABLE, dt_upsert("df_login_otp", "phone"), 840, 1040, executeOnce=True)

SEND_CODE_JS = r"""
const c = $('Make Login Code').first().json;
return [{ json: {
  url: c.graph_url, token: c.token,
  payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: c.phone,
             type: 'text',
             text: { body: c.code + ' is your ' + c.business_name +
                     ' dashboard code. It expires in 10 minutes.', preview_url: false } }
} }];
"""
b.node("Build Code Message", CODE, {"jsCode": SEND_CODE_JS}, 1040, 1040, executeOnce=True)
b.node("Send Code", HTTP,
       {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
        "headerParameters": {"parameters": [
            {"name": "Authorization", "value": "=Bearer {{ $json.token }}"},
            {"name": "Content-Type", "value": "application/json"}]},
        "sendBody": True, "contentType": "json", "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.payload) }}", "options": {"timeout": 15000}},
       1240, 1040, onError="continueRegularOutput")
b.node("Respond Login Sent", RESPOND,
       respond_json('={{ JSON.stringify({ok:true, sent:true}) }}'), 1440, 1040)

VERIFY_JS = r"""
const b = $('Auth & Route').first().json.body || {};
const digits = s => String(s == null ? '' : s).replace(/[^0-9]/g, '');
const phone = '+' + digits(b.phone);
const given = digits(b.code);
const rows = $('Read Code').all().map(i => i.json).filter(r => r && r.phone);
const row = rows.find(r => String(r.phone) === phone);

let ok = false, why = 'no code requested';
if (row) {
  const attempts = Number(row.attempts || 0);
  if (row.used === true) why = 'code already used';
  else if (attempts >= 5) why = 'too many attempts';
  else if (Number(row.expires_at || 0) < Date.now()) why = 'code expired';
  else if (String(row.code) !== given || !given) why = 'wrong code';
  else { ok = true; why = ''; }
}
// Always write the attempt back so a brute force runs out of tries.
const next = Object.assign({}, row || { phone: phone, code: '', expires_at: 0, created_at: new Date().toISOString() },
  { attempts: Number((row || {}).attempts || 0) + 1, used: ok ? true : !!(row || {}).used });
delete next.id; delete next.createdAt; delete next.updatedAt;
return [{ json: { ok: ok, why: why, phone: phone, row: next } }];
"""
b.node("Read Code", DATATABLE,
       dt_get("df_login_otp", [{"keyName": "phone", "condition": "eq",
                                "keyValue": "={{ '+' + $('Auth & Route').first().json.body.phone.replace(/[^0-9]/g,'') }}"}],
              return_all=False), 420, 1400, alwaysOutputData=True, executeOnce=True)
b.node("Check Code", CODE, {"jsCode": VERIFY_JS}, 620, 1400, executeOnce=True)
b.node("Save Attempt", DATATABLE,
       {"resource": "row", "operation": "upsert",
        "dataTableId": {"__rl": True, "mode": "name", "value": "df_login_otp"},
        "matchType": "allConditions",
        "filters": {"conditions": [{"keyName": "phone", "condition": "eq",
                                    "keyValue": "={{ $json.row.phone }}"}]},
        "columns": {"mappingMode": "defineBelow", "matchingColumns": ["phone"],
                    "value": {"phone": "={{ $json.row.phone }}",
                              "code": "={{ $json.row.code }}",
                              "expires_at": "={{ $json.row.expires_at }}",
                              "used": "={{ $json.row.used }}",
                              "attempts": "={{ $json.row.attempts }}"},
                    "schema": []},
        "options": {"dryRun": False}}, 840, 1400, executeOnce=True, onError="continueRegularOutput")
b.node("Respond Verify", RESPOND,
       respond_json('={{ JSON.stringify({ok: $(\'Check Code\').first().json.ok, error: $(\'Check Code\').first().json.why}) }}'),
       1040, 1400)

# ------------------------------------------------------------------ wiring
b.link("Console Webhook", "Read Config")
b.link("Read Config", "Auth & Route")
b.link("Auth & Route", "Authorized?")
b.link("Authorized?", "Route Action", 0)
b.link("Authorized?", "Respond 401", 1)

b.link("Route Action", "Read Orders", 0)
b.link("Read Orders", "Read Handoffs")
b.link("Read Handoffs", "Read Catalog")
b.link("Read Catalog", "Build State")
b.link("Build State", "Respond State")

b.link("Route Action", "Build Update", 1)
b.link("Build Update", "Route Target")

b.link("Route Action", "Make Login Code", 2)
b.link("Make Login Code", "Allowed?")
b.link("Allowed?", "Store Code", 0)
b.link("Allowed?", "Respond Login Denied", 1)
b.link("Store Code", "Build Code Message")
b.link("Build Code Message", "Send Code")
b.link("Send Code", "Respond Login Sent")

b.link("Route Action", "Read Code", 3)
b.link("Read Code", "Check Code")
b.link("Check Code", "Save Attempt")
b.link("Save Attempt", "Respond Verify")

b.link("Route Action", "Respond 400", 4)

if __name__ == "__main__":
    orphans = b.check("Console Webhook")
    os.makedirs(BUILD, exist_ok=True)
    path = os.path.join(BUILD, "dailyfresh-console.workflow.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(b.workflow("DailyFresh - Console API"), f, indent=1)
    print("%d nodes, %d connection sources" % (len(b.nodes), len(b.conns)))
    if orphans:
        print("unreachable: %s" % orphans)
    print("endpoint: POST /webhook/%s" % PATH)
    print("wrote " + path)
