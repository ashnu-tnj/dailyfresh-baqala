#!/usr/bin/env python3
"""Generate the DailyFresh WhatsApp bot workflow JSON for n8n.

The engine is NOT duplicated here - engine.js is read from disk and inlined into
the Engine Code node, so the workflow that runs is exactly the code the local
test suite exercises.

    python n8n/build-workflow.py          -> n8n/build/dailyfresh-bot.workflow.json
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
ENGINE = open(os.path.join(HERE, "engine.js"), encoding="utf-8").read()

WEBHOOK_PATH = "dailyfresh/wa"
GRAPH_VERSION = "v21.0"

nodes = []
conns = {}


def node(name, ntype, version, params, x, y, **extra):
    n = {"parameters": params, "id": name.lower().replace(" ", "-").replace("?", "").replace("/", "-"),
         "name": name, "type": ntype, "typeVersion": version, "position": [x, y]}
    n.update(extra)
    nodes.append(n)
    return name


def link(src, dst, out=0):
    conns.setdefault(src, {}).setdefault("main", [])
    while len(conns[src]["main"]) <= out:
        conns[src]["main"].append([])
    conns[src]["main"][out].append({"node": dst, "type": "main", "index": 0})


def cond_str(left, op, right):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "c1", "leftValue": left,
                            "operator": {"type": "string", "operation": op},
                            "rightValue": right}],
            "combinator": "and"}


def cond_bool(left, op):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "c1", "leftValue": left,
                            "operator": {"type": "boolean", "operation": op, "singleValue": True}}],
            "combinator": "and"}


def dt_get(table, filters=None, return_all=True, limit=1):
    p = {"resource": "row", "operation": "get",
         "dataTableId": {"__rl": True, "mode": "name", "value": table},
         "returnAll": return_all}
    if filters:
        p["matchType"] = "allConditions"
        p["filters"] = {"conditions": filters}
    if not return_all:
        p["limit"] = limit
    return p


def dt_upsert(table, match_col):
    return {"resource": "row", "operation": "upsert",
            "dataTableId": {"__rl": True, "mode": "name", "value": table},
            "matchType": "allConditions",
            "filters": {"conditions": [{"keyName": match_col, "condition": "eq",
                                        "keyValue": "={{ $json['" + match_col + "'] }}"}]},
            "columns": {"mappingMode": "autoMapInputData", "matchingColumns": [match_col], "schema": []},
            "options": {"dryRun": False}}


# --------------------------------------------------------------- 1. intake
node("Webhook", "n8n-nodes-base.webhook", 2.1,
     {"multipleMethods": True, "path": WEBHOOK_PATH, "responseMode": "responseNode",
      "options": {"allowedOrigins": "*"}}, -640, 300,
     webhookId="dailyfresh-wa-hook")

node("Is Verification?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_str("={{ $json.query ? $json.query['hub.mode'] : '' }}", "equals", "subscribe"),
      "options": {}}, -420, 300)

node("Echo Challenge", "n8n-nodes-base.respondToWebhook", 1.5,
     {"respondWith": "text", "responseBody": "={{ $json.query['hub.challenge'] }}", "options": {}}, -200, 180)

node("Respond 200", "n8n-nodes-base.respondToWebhook", 1.5,
     {"respondWith": "text", "responseBody": "EVENT_RECEIVED", "options": {}}, -200, 400)

node("Only Messages", "n8n-nodes-base.filter", 2.3,
     {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                     "conditions": [{"id": "m1",
                                     "leftValue": "={{ $json.body && $json.body.entry && $json.body.entry[0] && $json.body.entry[0].changes && $json.body.entry[0].changes[0] && $json.body.entry[0].changes[0].value && $json.body.entry[0].changes[0].value.messages ? true : false }}",
                                     "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
                     "combinator": "and"},
      "options": {}}, 20, 400)

# Meta nests the useful bits four levels deep and uses a different shape per
# message type; everything downstream reads this flat object instead.
NORMALIZE_JS = r"""
const out = [];
for (const item of $input.all()) {
  const b = item.json.body || item.json || {};
  const entry = (b.entry || [])[0] || {};
  const change = (entry.changes || [])[0] || {};
  const v = change.value || {};
  const msg = (v.messages || [])[0];
  if (!msg) continue;

  const contact = (v.contacts || [])[0] || {};
  const meta = v.metadata || {};

  let text = '';
  let reply_id = '';
  let latitude = '';
  let longitude = '';

  if (msg.type === 'text') {
    text = (msg.text && msg.text.body) || '';
  } else if (msg.type === 'interactive') {
    const inter = msg.interactive || {};
    if (inter.button_reply) { reply_id = inter.button_reply.id || ''; text = inter.button_reply.title || ''; }
    else if (inter.list_reply) { reply_id = inter.list_reply.id || ''; text = inter.list_reply.title || ''; }
  } else if (msg.type === 'button') {
    // Quick-reply button on a template.
    reply_id = (msg.button && msg.button.payload) || '';
    text = (msg.button && msg.button.text) || '';
  } else if (msg.type === 'location') {
    latitude = (msg.location && msg.location.latitude) !== undefined ? msg.location.latitude : '';
    longitude = (msg.location && msg.location.longitude) !== undefined ? msg.location.longitude : '';
  }

  const from = String(msg.from || '');
  out.push({
    json: {
      phone: from.charAt(0) === '+' ? from : ('+' + from),
      wa_id: contact.wa_id || from,
      profile_name: (contact.profile && contact.profile.name) || '',
      message_id: msg.id || '',
      msg_type: msg.type || '',
      text: text,
      reply_id: reply_id,
      latitude: latitude,
      longitude: longitude,
      phone_number_id: meta.phone_number_id || '',
      received_at: new Date().toISOString()
    }
  });
}
return out;
"""
node("Normalize Inbound", "n8n-nodes-base.code", 2, {"jsCode": NORMALIZE_JS}, 240, 400)

# --------------------------------------------------------------- 2. reads
# alwaysOutputData keeps the chain alive when a customer or session row does not
# exist yet - "no row" is a normal state the engine is built to handle.
node("Read Config", "n8n-nodes-base.dataTable", 1.1, dt_get("df_config"), 460, 400,
     alwaysOutputData=True, executeOnce=True)
node("Read Catalog", "n8n-nodes-base.dataTable", 1.1, dt_get("df_catalog"), 660, 400,
     alwaysOutputData=True, executeOnce=True)
node("Read Customer", "n8n-nodes-base.dataTable", 1.1,
     dt_get("df_customers", [{"keyName": "phone", "condition": "eq",
                              "keyValue": "={{ $('Normalize Inbound').first().json.phone }}"}],
            return_all=False), 860, 400,
     alwaysOutputData=True, executeOnce=True)
node("Read Session", "n8n-nodes-base.dataTable", 1.1,
     dt_get("df_sessions", [{"keyName": "phone", "condition": "eq",
                             "keyValue": "={{ $('Normalize Inbound').first().json.phone }}"}],
            return_all=False), 1060, 400,
     alwaysOutputData=True, executeOnce=True)

# --------------------------------------------------------------- 3. ollama
NEEDS_LLM_JS = r"""
// Decide whether the model is worth calling at all. In a tap-first bot most
// turns are button or list replies, which never need it.
const inb = $('Normalize Inbound').first().json;
const cfgRows = $('Read Config').all().map(i => i.json).filter(r => r && r.config_key);
const cfg = {};
for (const r of cfgRows) cfg[r.config_key] = r.value;

const sessRows = $('Read Session').all().map(i => i.json).filter(r => r && r.phone);
const step = sessRows.length ? String(sessRows[0].current_step || '') : '';

const enabled = String(cfg.llm_enabled === undefined ? 'true' : cfg.llm_enabled).toLowerCase() !== 'false';
const text = String(inb.text || '').trim();
const upper = text.toUpperCase().replace(/\s+/g, ' ').trim();

const COMMANDS = ['HELP','CART','BASKET','CANCEL','CONFIRM','DONE','MENU','LIST','PRICES','ORDER',
  'ORDER NOW','START','STAFF','AGENT','HUMAN','SUPPORT','RESUME','BOT','HI','HELLO','HEY'];

const isTap = String(inb.reply_id || '') !== '';
const isNumber = /^[0-9]{1,4}$/.test(upper);
const isCommand = COMMANDS.indexOf(upper) >= 0;
const hasLetters = /[a-z]/i.test(text);
const isLocation = inb.latitude !== '' && inb.latitude !== null && inb.latitude !== undefined;

const ITEM_STEPS = ['browsing','category','cart_review','awaiting_search','awaiting_pack','start','confirm_saved'];
const wantItems = ITEM_STEPS.indexOf(step) >= 0 || step === '';
const wantAddress = step === 'awaiting_address';

const use = enabled && !isTap && !isNumber && !isCommand && !isLocation && hasLetters &&
            text.length >= 3 && (wantItems || wantAddress);

const mode = wantAddress ? 'address' : 'items';

const itemPrompt =
  'Split this grocery order into items. Reply ONLY with JSON of the form ' +
  '{"items":[{"qty":<number>,"amount":"<size or empty>","name":"<item words>"}]}. ' +
  'Copy the item words exactly as the customer wrote them - never translate, never invent, ' +
  'never add anything that is not in the message. If there is no order, reply {"items":[]}.\n\n' +
  'Message: ' + text;

const addressPrompt =
  'Extract a delivery address. Reply ONLY with JSON of the form ' +
  '{"address":{"flat":"","building":"","street":"","landmark":""}}. ' +
  'Copy words exactly from the message; leave a field empty if it is not present.\n\n' +
  'Message: ' + text;

return [{ json: {
  use: use,
  mode: mode,
  raw_text: text,
  model: cfg.llm_model || 'llama3.2:1b',
  url: String(cfg.llm_url || 'http://ollama:11434').replace(/\/+$/, '') + '/api/generate',
  prompt: mode === 'address' ? addressPrompt : itemPrompt
} }];
"""
node("Needs Ollama?", "n8n-nodes-base.code", 2, {"jsCode": NEEDS_LLM_JS}, 1260, 400, executeOnce=True)

node("Use Ollama?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $json.use }}", "true"), "options": {}}, 1460, 400)

node("Ollama Normalise", "n8n-nodes-base.httpRequest", 4.5,
     {"method": "POST", "url": "={{ $json.url }}", "sendBody": True, "contentType": "json",
      "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify({ model: $json.model, prompt: $json.prompt, stream: false, format: 'json', keep_alive: '24h', options: { temperature: 0, num_predict: 150 } }) }}",
      "options": {"timeout": 4000}}, 1660, 300,
     onError="continueRegularOutput", executeOnce=True)

# The grounding check itself lives in engine.js; this only parses and shapes.
LLM_RESULT_JS = r"""
const need = $('Needs Ollama?').first().json;
let parsed = null;
if (need.use) {
  const rows = $input.all();
  const raw = rows.length ? rows[0].json : null;
  const body = raw && (raw.response !== undefined ? raw.response : raw);
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (e) {
    parsed = null;   // fail open - the engine falls back to its own parser
  }
}
let llm = null;
if (parsed) {
  if (need.mode === 'address' && parsed.address) llm = { address: parsed.address };
  else if (Array.isArray(parsed.items)) llm = { items: parsed.items };
}
return [{ json: { llm: llm } }];
"""
node("Ollama Result", "n8n-nodes-base.code", 2, {"jsCode": LLM_RESULT_JS}, 1860, 400,
     alwaysOutputData=True, executeOnce=True)

# Read the session again, AFTER the model call. Ollama can take seconds; leaving
# the only session read on the far side of it meant a second message could read
# pre-update state, and the slow execution then overwrote the newer one. Reading
# here collapses the read-modify-write window to a few tens of milliseconds.
node("Read Session Fresh", "n8n-nodes-base.dataTable", 1.1,
     dt_get("df_sessions", [{"keyName": "phone", "condition": "eq",
                             "keyValue": "={{ $('Normalize Inbound').first().json.phone }}"}],
            return_all=False), 1960, 400,
     alwaysOutputData=True, executeOnce=True)

# --------------------------------------------------------------- 4. engine
ENGINE_ADAPTER = r"""

// ---------------------------------------------------------------- n8n adapter
const inb = $('Normalize Inbound').first().json;
const configRows = $('Read Config').all().map(i => i.json).filter(r => r && r.config_key);
const catalogRows = $('Read Catalog').all().map(i => i.json).filter(r => r && r.item_code);
const customerRows = $('Read Customer').all().map(i => i.json).filter(r => r && r.phone);
const sessionRows = $('Read Session Fresh').all().map(i => i.json).filter(r => r && r.phone);
const llmRows = $('Ollama Result').all().map(i => i.json);

const result = runEngine({
  now: new Date().toISOString(),
  inbound: inb,
  config: configRows,
  catalog: catalogRows,
  customer: customerRows.length ? customerRows[0] : null,
  session: sessionRows.length ? sessionRows[0] : null,
  llm: llmRows.length ? llmRows[0].llm : null
});

const cfg = {};
for (const r of configRows) cfg[r.config_key] = r.value;

return [{ json: {
  duplicate: !!result.duplicate,
  send: result.send || null,
  has_reply: !!result.send,
  session: result.session,
  customer: result.customer || null,
  has_customer: !!result.customer,
  order: result.order || null,
  has_order: !!result.order,
  handoff: result.handoff || null,
  has_handoff: !!result.handoff,
  event: result.event,
  to: inb.phone,
  phone_number_id: cfg.phone_number_id || inb.phone_number_id || '',
  access_token: cfg.access_token || '',
  graph_version: cfg.graph_version || '%s',
  notify_url: cfg.console_notify_url || '',
  notify_token: cfg.console_admin_token || '',
  business_name: cfg.business_name || ''
} }];
""" % GRAPH_VERSION

node("Engine", "n8n-nodes-base.code", 2, {"jsCode": ENGINE + ENGINE_ADAPTER}, 2060, 400,
     executeOnce=True)

node("Is Duplicate?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $json.duplicate }}", "true"), "options": {}}, 2260, 400)

node("Ignore Duplicate", "n8n-nodes-base.noOp", 1, {}, 2460, 260)

# Every IF after the Engine must read the Engine's own output by name. They sit
# downstream of data-table writes whose output item is the written ROW, so a bare
# $json.<flag> is undefined there and the branch silently takes the false path.
node("Has Reply?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $('Engine').first().json.has_reply }}", "true"), "options": {}},
     2460, 520)

# --------------------------------------------------------------- 5. send
BUILD_SEND_JS = r"""
// Turn the engine's neutral message description into a Cloud API send body.
const e = $('Engine').first().json;
const s = e.send;
if (!s) return [];

const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: e.to };
let payload;

if (s.kind === 'text') {
  payload = Object.assign({}, base, { type: 'text', text: { body: s.body, preview_url: false } });

} else if (s.kind === 'buttons') {
  const inter = {
    type: 'button',
    body: { text: s.body },
    action: { buttons: s.buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
  };
  if (s.header) inter.header = { type: 'text', text: s.header };
  if (s.footer) inter.footer = { text: s.footer };
  payload = Object.assign({}, base, { type: 'interactive', interactive: inter });

} else if (s.kind === 'list') {
  const inter = {
    type: 'list',
    body: { text: s.body },
    action: { button: s.button, sections: s.sections }
  };
  if (s.header) inter.header = { type: 'text', text: s.header };
  if (s.footer) inter.footer = { text: s.footer };
  payload = Object.assign({}, base, { type: 'interactive', interactive: inter });

} else if (s.kind === 'location_request') {
  payload = Object.assign({}, base, {
    type: 'interactive',
    interactive: { type: 'location_request_message', body: { text: s.body },
                   action: { name: 'send_location' } }
  });

} else {
  payload = Object.assign({}, base, { type: 'text', text: { body: s.body || '' } });
}

return [{ json: {
  url: 'https://graph.facebook.com/' + e.graph_version + '/' + e.phone_number_id + '/messages',
  token: e.access_token,
  payload: payload
} }];
"""
node("Build Send Payload", "n8n-nodes-base.code", 2, {"jsCode": BUILD_SEND_JS}, 2660, 620)

node("Send Reply", "n8n-nodes-base.httpRequest", 4.5,
     {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
      "headerParameters": {"parameters": [
          {"name": "Authorization", "value": "=Bearer {{ $json.token }}"},
          {"name": "Content-Type", "value": "application/json"}]},
      "sendBody": True, "contentType": "json", "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify($json.payload) }}",
      "options": {"timeout": 15000}}, 2860, 620,
     onError="continueRegularOutput")

# --------------------------------------------------------------- 6. persist
node("Session Row", "n8n-nodes-base.code", 2,
     {"jsCode": "return [{ json: $('Engine').first().json.session }];"}, 3060, 400)
node("Upsert Session", "n8n-nodes-base.dataTable", 1.1, dt_upsert("df_sessions", "phone"), 3260, 400,
     executeOnce=True, onError="continueRegularOutput")

node("Has Customer?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $('Engine').first().json.has_customer }}", "true"), "options": {}},
     3460, 400)
node("Customer Row", "n8n-nodes-base.code", 2,
     {"jsCode": "return [{ json: $('Engine').first().json.customer }];"}, 3660, 280)
node("Upsert Customer", "n8n-nodes-base.dataTable", 1.1, dt_upsert("df_customers", "phone"), 3860, 280,
     executeOnce=True, onError="continueRegularOutput")

node("Has Order?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $('Engine').first().json.has_order }}", "true"), "options": {}},
     4060, 400)
node("Order Row", "n8n-nodes-base.code", 2,
     {"jsCode": "return [{ json: $('Engine').first().json.order }];"}, 4260, 280)
node("Write Order", "n8n-nodes-base.dataTable", 1.1, dt_upsert("df_orders", "order_id"), 4460, 280,
     executeOnce=True, onError="continueRegularOutput")

PUSH_ORDER_JS = r"""
const e = $('Engine').first().json;
const o = e.order || {};
return [{ json: {
  url: e.notify_url,
  token: e.notify_token,
  payload: {
    title: 'New order from ' + (o.customer_name || 'a customer'),
    body: (o.items_text || '').split('\n').join(', ') + ' - ' + o.total,
    tag: 'order-' + o.order_id,
    requireInteraction: true,
    url: './'
  }
} }];
"""
node("Push Order", "n8n-nodes-base.code", 2, {"jsCode": PUSH_ORDER_JS}, 4660, 280)
node("Notify Order", "n8n-nodes-base.httpRequest", 4.5,
     {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
      "headerParameters": {"parameters": [{"name": "x-admin-token", "value": "={{ $json.token }}"}]},
      "sendBody": True, "contentType": "json", "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify($json.payload) }}", "options": {"timeout": 8000}},
     4860, 280, onError="continueRegularOutput")

node("Has Handoff?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $('Engine').first().json.has_handoff }}", "true"), "options": {}},
     5060, 400)

HANDOFF_ROW_JS = r"""
const e = $('Engine').first().json;
const h = e.handoff || {};
const phone = h.customer_phone || '';
const row = {
  handoff_id: 'HO-' + String(phone).replace(/[^0-9]/g, ''),
  customer_phone: phone,
  customer_name: h.customer_name || '',
  last_message_text: h.last_message_text || '',
  last_message_at: h.last_message_at || new Date().toISOString(),
  status: h.status || 'open'
};
if (h.action === 'open') row.opened_at = h.opened_at || new Date().toISOString();
if (h.action === 'close') { row.status = 'closed'; row.closed_at = h.closed_at || new Date().toISOString(); }
return [{ json: { row: row, action: h.action, notify: h.action === 'open' } }];
"""
node("Handoff Row", "n8n-nodes-base.code", 2, {"jsCode": HANDOFF_ROW_JS}, 5260, 280)
node("Write Handoff", "n8n-nodes-base.dataTable", 1.1,
     {"resource": "row", "operation": "upsert",
      "dataTableId": {"__rl": True, "mode": "name", "value": "df_handoffs"},
      "matchType": "allConditions",
      "filters": {"conditions": [{"keyName": "handoff_id", "condition": "eq",
                                  "keyValue": "={{ $json.row.handoff_id }}"}]},
      "columns": {"mappingMode": "defineBelow", "matchingColumns": ["handoff_id"],
                  "value": {
                      "handoff_id": "={{ $json.row.handoff_id }}",
                      "customer_phone": "={{ $json.row.customer_phone }}",
                      "customer_name": "={{ $json.row.customer_name }}",
                      "last_message_text": "={{ $json.row.last_message_text }}",
                      "last_message_at": "={{ $json.row.last_message_at }}",
                      "status": "={{ $json.row.status }}"},
                  "schema": []},
      "options": {"dryRun": False}}, 5460, 280,
     executeOnce=True, onError="continueRegularOutput")

node("Notify Handoff?", "n8n-nodes-base.if", 2.3,
     {"conditions": cond_bool("={{ $('Handoff Row').first().json.notify }}", "true"), "options": {}},
     5660, 280)

PUSH_HANDOFF_JS = r"""
const e = $('Engine').first().json;
const h = e.handoff || {};
return [{ json: {
  url: e.notify_url,
  token: e.notify_token,
  payload: {
    title: (h.customer_name || 'A customer') + ' wants to chat',
    body: h.last_message_text || 'Tapped Talk to Staff',
    tag: 'handoff-' + (h.customer_phone || ''),
    requireInteraction: true,
    url: './'
  }
} }];
"""
node("Push Handoff", "n8n-nodes-base.code", 2, {"jsCode": PUSH_HANDOFF_JS}, 5860, 180)
node("Notify Staff", "n8n-nodes-base.httpRequest", 4.5,
     {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
      "headerParameters": {"parameters": [{"name": "x-admin-token", "value": "={{ $json.token }}"}]},
      "sendBody": True, "contentType": "json", "specifyBody": "json",
      "jsonBody": "={{ JSON.stringify($json.payload) }}", "options": {"timeout": 8000}},
     6060, 180, onError="continueRegularOutput")

EVENT_ROW_JS = r"""
const e = $('Engine').first().json;
const ev = e.event || {};
const phone = e.to || '';
return [{ json: {
  event_id: 'EV-' + Date.now() + '-' + String(phone).replace(/[^0-9]/g, '').slice(-4),
  ts: new Date().toISOString(),
  level: ev.level || 'info',
  actor: phone,
  action: ev.action || 'noop',
  detail: String(ev.detail || '').slice(0, 500),
  ref_id: ev.ref_id || ''
} }];
"""
node("Event Row", "n8n-nodes-base.code", 2, {"jsCode": EVENT_ROW_JS}, 6260, 400)
node("Append Event", "n8n-nodes-base.dataTable", 1.1, dt_upsert("df_events", "event_id"), 6460, 400,
     executeOnce=True, onError="continueRegularOutput")

# --------------------------------------------------------------- wiring
# BOTH webhook outputs must reach the verification check. Output 0 is GET and
# output 1 is POST; wiring only output 0 gives a webhook that verifies perfectly
# with Meta and then silently drops every real message.
link("Webhook", "Is Verification?", 0)
link("Webhook", "Is Verification?", 1)
link("Is Verification?", "Echo Challenge", 0)
link("Is Verification?", "Respond 200", 1)
link("Respond 200", "Only Messages")
link("Only Messages", "Normalize Inbound")
link("Normalize Inbound", "Read Config")
link("Read Config", "Read Catalog")
link("Read Catalog", "Read Customer")
link("Read Customer", "Read Session")
link("Read Session", "Needs Ollama?")
link("Needs Ollama?", "Use Ollama?")
link("Use Ollama?", "Ollama Normalise", 0)
link("Use Ollama?", "Ollama Result", 1)
link("Ollama Normalise", "Ollama Result")
link("Ollama Result", "Read Session Fresh")
link("Read Session Fresh", "Engine")
link("Engine", "Is Duplicate?")
link("Is Duplicate?", "Ignore Duplicate", 0)
link("Is Duplicate?", "Session Row", 1)
link("Has Reply?", "Build Send Payload", 0)
link("Has Reply?", "Has Customer?", 1)
link("Build Send Payload", "Send Reply")
link("Send Reply", "Has Customer?")
link("Session Row", "Upsert Session")
link("Upsert Session", "Has Reply?")
link("Has Customer?", "Customer Row", 0)
link("Has Customer?", "Has Order?", 1)
link("Customer Row", "Upsert Customer")
link("Upsert Customer", "Has Order?")
link("Has Order?", "Order Row", 0)
link("Has Order?", "Has Handoff?", 1)
link("Order Row", "Write Order")
link("Write Order", "Push Order")
link("Push Order", "Notify Order")
link("Notify Order", "Has Handoff?")
link("Has Handoff?", "Handoff Row", 0)
link("Has Handoff?", "Event Row", 1)
link("Handoff Row", "Write Handoff")
link("Write Handoff", "Notify Handoff?")
link("Notify Handoff?", "Push Handoff", 0)
link("Notify Handoff?", "Event Row", 1)
link("Push Handoff", "Notify Staff")
link("Notify Staff", "Event Row")
link("Event Row", "Append Event")

workflow = {
    "name": "DailyFresh - WhatsApp Bot (Baqala)",
    "nodes": nodes,
    "connections": conns,
    "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                 "saveDataErrorExecution": "all", "saveDataSuccessExecution": "all"},
}

if __name__ == "__main__":
    os.makedirs(BUILD, exist_ok=True)
    path = os.path.join(BUILD, "dailyfresh-bot.workflow.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(workflow, f, indent=1)

    # Guard: a post-Engine IF that reads a bare $json flag is the bug that made
    # the bot go silent on its first real message.
    ENGINE_FLAGS = ("has_reply", "has_customer", "has_order", "has_handoff", "duplicate")
    for n in nodes:
        if n["type"] != "n8n-nodes-base.if":
            continue
        for c in n["parameters"].get("conditions", {}).get("conditions", []):
            left = str(c.get("leftValue", ""))
            for flag in ENGINE_FLAGS:
                if flag in left and "$('Engine')" not in left and n["name"] != "Is Duplicate?":
                    raise SystemExit(
                        "%s reads %s via a bare $json; use $('Engine').first().json.%s"
                        % (n["name"], flag, flag))

    names = [n["name"] for n in nodes]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise SystemExit("Duplicate node names: %s" % sorted(dupes))
    targets = set()
    for src, c in conns.items():
        for out in c["main"]:
            for t in out:
                targets.add(t["node"])
    unknown = targets - set(names)
    if unknown:
        raise SystemExit("Connections point at unknown nodes: %s" % sorted(unknown))
    orphans = [n for n in names if n not in targets and n != "Webhook"]

    print("%d nodes, %d connection sources" % (len(nodes), len(conns)))
    print("engine inlined: %d bytes" % len(ENGINE))
    print("webhook path: /webhook/%s" % WEBHOOK_PATH)
    if orphans:
        print("unreachable nodes: %s" % orphans)
    print("wrote " + path)
