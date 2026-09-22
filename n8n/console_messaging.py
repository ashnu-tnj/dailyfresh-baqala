#!/usr/bin/env python3
"""The staff-facing WhatsApp branches of the Console API.

Three actions, all of them things a shop's own staff do from the dashboard:

  wa_send          reply to a customer in the open conversation
  templates        list the message templates on the WhatsApp account
  template_create  submit a new template for WhatsApp's approval

Everything here runs inside n8n because that is where the access token lives.
The console container posts an action and gets JSON back; it never sees a token
and never talks to Graph itself.

These are also the two capabilities Meta's App Review asks to see on video:
sending a message from the business interface (`whatsapp_business_messaging`)
and creating a template (`whatsapp_business_management`).
"""
from wfkit import IF, CODE, HTTP, DATATABLE, RESPOND, cond_str, cond_bool, dt_upsert, respond_json

# --------------------------------------------------------------------- wa_send
BUILD_SEND_JS = r"""
const r = $('Auth & Route').first().json;
const cfg = r.cfg || {};
const b = r.body || {};
const digits = s => String(s == null ? '' : s).replace(/[^0-9]/g, '');
const to = digits(b.phone);
const text = String(b.text == null ? '' : b.text).trim();

if (!to) return [{ json: { fail: 'no recipient' } }];
if (!text) return [{ json: { fail: 'nothing to send' } }];
// Meta's own cap on a text body. Better to refuse here than to have Graph do it.
if (text.length > 1024) return [{ json: { fail: 'message is longer than 1024 characters' } }];
if (!cfg.phone_number_id || !cfg.access_token) {
  return [{ json: { fail: 'no WhatsApp number is connected yet' } }];
}
const v = cfg.graph_version || 'v21.0';
return [{ json: {
  fail: '', to: '+' + to, text: text, token: cfg.access_token,
  url: 'https://graph.facebook.com/' + v + '/' + cfg.phone_number_id + '/messages',
  payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '+' + to,
             type: 'text', text: { body: text, preview_url: false } }
} }];
"""

CHECK_SEND_JS = r"""
const built = $('Build WA Send').first().json;
const res = $('Send WA Text').first().json || {};
const sent = !!(res.messages && res.messages.length);
let err = '';
if (!sent) {
  const e = res.error || {};
  err = String(e.message || 'the message was not sent');
  // 131047 is the one staff will actually hit: the customer has gone quiet for
  // more than 24 hours, so WhatsApp only allows a template from here.
  if (String(e.code) === '131047' || /24 hour|re-?engagement/i.test(err)) {
    err = 'This customer has not messaged for over 24 hours, so WhatsApp only allows a template message now.';
  }
}
const stamp = new Date().toISOString();
return [{ json: {
  ok: sent,
  error: err,
  message_id: sent ? String(res.messages[0].id || '') : '',
  event: {
    event_id: 'ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ts: stamp,
    level: sent ? 'info' : 'error',
    actor: 'console',
    action: sent ? 'staff_reply_sent' : 'staff_reply_failed',
    detail: (sent ? built.text : err).slice(0, 400),
    ref_id: built.to
  }
} }];
"""

SEND_OK_EXPR = ("={{ JSON.stringify({ok:true, "
                "message_id: $('Check Send').first().json.message_id}) }}")
SEND_ERR_EXPR = ("={{ JSON.stringify({ok:false, error: "
                 "($('Build WA Send').first().json.fail) || "
                 "($('Check Send').isExecuted ? $('Check Send').first().json.error : '') || "
                 "'the message was not sent'}) }}")


def add_wa_send(b, route_output):
    """Staff replies to a customer from the dashboard."""
    y = 2100
    b.node("Build WA Send", CODE, {"jsCode": BUILD_SEND_JS}, 420, y, executeOnce=True)
    b.node("Sendable?", IF,
           {"conditions": cond_str("={{ $json.fail }}", "equals", ""), "options": {}}, 620, y)
    b.node("Respond Send Error", RESPOND, respond_json(SEND_ERR_EXPR, 400), 1620, y + 220)

    b.node("Send WA Text", HTTP,
           {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $json.token }}"},
                {"name": "Content-Type", "value": "application/json"}]},
            "sendBody": True, "contentType": "json", "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.payload) }}", "options": {"timeout": 15000}},
           820, y, onError="continueRegularOutput", executeOnce=True)
    b.node("Check Send", CODE, {"jsCode": CHECK_SEND_JS}, 1020, y, executeOnce=True)
    # Split out so the Data Table node receives the event columns and nothing else.
    b.node("Send Event Row", CODE, {"jsCode": "return [{ json: $json.event }];"},
           1220, y, executeOnce=True)
    b.node("Write Send Event", DATATABLE, dt_upsert("df_events", "event_id"), 1420, y,
           executeOnce=True, onError="continueRegularOutput")
    # Reads Check Send by name: downstream of the Data Table the item is the
    # written row, not the result.
    b.node("Sent OK?", IF,
           {"conditions": cond_bool("={{ $('Check Send').first().json.ok }}"), "options": {}},
           1620, y)
    b.node("Respond Send", RESPOND, respond_json(SEND_OK_EXPR), 1820, y - 80)

    b.link("Route Action", "Build WA Send", route_output)
    b.link("Build WA Send", "Sendable?")
    b.link("Sendable?", "Send WA Text", 0)
    b.link("Sendable?", "Respond Send Error", 1)
    b.link("Send WA Text", "Check Send")
    b.link("Check Send", "Send Event Row")
    b.link("Send Event Row", "Write Send Event")
    b.link("Write Send Event", "Sent OK?")
    b.link("Sent OK?", "Respond Send", 0)
    b.link("Sent OK?", "Respond Send Error", 1)


# ------------------------------------------------------------------- templates
BUILD_LIST_JS = r"""
const cfg = $('Auth & Route').first().json.cfg || {};
if (!cfg.waba_id || !cfg.access_token) {
  return [{ json: { fail: 'no WhatsApp account is connected yet' } }];
}
const v = cfg.graph_version || 'v21.0';
return [{ json: { fail: '', token: cfg.access_token,
  url: 'https://graph.facebook.com/' + v + '/' + cfg.waba_id +
       '/message_templates?limit=100&fields=name,status,category,language,components,rejected_reason' } }];
"""

SHAPE_LIST_JS = r"""
const res = $('Fetch Templates').first().json || {};
if (res.error) {
  return [{ json: { ok: false, error: String(res.error.message || 'could not read templates') } }];
}
const list = (res.data || []).map(t => {
  const comps = t.components || [];
  const body = comps.find(c => c.type === 'BODY') || {};
  const btns = (comps.find(c => c.type === 'BUTTONS') || {}).buttons || [];
  return {
    name: t.name, status: t.status, category: t.category, language: t.language,
    body: String(body.text || ''),
    buttons: btns.map(x => String(x.text || '')),
    rejected_reason: t.status === 'REJECTED' ? String(t.rejected_reason || '') : ''
  };
});
list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
return [{ json: { ok: true, templates: list } }];
"""

BUILD_CREATE_JS = r"""
const r = $('Auth & Route').first().json;
const cfg = r.cfg || {};
const b = r.body || {};
if (!cfg.waba_id || !cfg.access_token) {
  return [{ json: { fail: 'no WhatsApp account is connected yet' } }];
}
// WhatsApp only accepts lowercase letters, digits and underscores.
const name = String(b.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
                                 .replace(/^_+|_+$/g, '').slice(0, 60);
if (name.length < 3) return [{ json: { fail: 'give the template a name of at least 3 characters' } }];

const category = String(b.category || 'UTILITY').toUpperCase();
if (['UTILITY', 'MARKETING', 'AUTHENTICATION'].indexOf(category) < 0) {
  return [{ json: { fail: 'category must be UTILITY, MARKETING or AUTHENTICATION' } }];
}
const body_text = String(b.body_text || '').trim();
if (!body_text) return [{ json: { fail: 'the template needs a message body' } }];
if (body_text.length > 1024) return [{ json: { fail: 'the body is longer than 1024 characters' } }];

const header = String(b.header_text || '').trim().slice(0, 60);
const footer = String(b.footer_text || '').trim().slice(0, 60);

// Meta's format rules for placeholders, all of which come back as the single
// unhelpful rejection reason INVALID_FORMAT hours later rather than as an error
// on create:
//   - they must run 1..n with nothing skipped
//   - the body may not open or close on one
//   - every one needs a sample value, or a reviewer sees "Hello {{1}}"
function placeholders(text) {
  const found = (text.match(/\{\{\s*(\d+)\s*\}\}/g) || [])
    .map(function (m) { return parseInt(m.replace(/[^0-9]/g, ''), 10); });
  return found;
}
const used = placeholders(body_text);
const n = used.length ? Math.max.apply(null, used) : 0;
for (var i = 1; i <= n; i++) {
  if (used.indexOf(i) < 0) {
    return [{ json: { fail: 'the message skips {{' + i + '}} - number the blanks 1, 2, 3 with none missing' } }];
  }
}
if (n > 0) {
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body_text)) {
    return [{ json: { fail: 'the message cannot start with a blank - put a word before {{1}}' } }];
  }
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body_text)) {
    return [{ json: { fail: 'the message cannot end with a blank - put a word after the last one' } }];
  }
}

// Samples typed by staff, padded out if they gave fewer than the message needs.
const given = (Array.isArray(b.examples) ? b.examples : [])
  .map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
const samples = [];
for (var j = 0; j < n; j++) {
  samples.push(given[j] || ('Sample ' + (j + 1)));
}

const components = [];
if (header) {
  const hc = { type: 'HEADER', format: 'TEXT', text: header };
  const hn = placeholders(header).length;
  if (hn) hc.example = { header_text: ['Sample'] };
  components.push(hc);
}
const bodyComponent = { type: 'BODY', text: body_text };
// body_text is an array of one row: one full set of values for the message.
if (n) bodyComponent.example = { body_text: [samples] };
components.push(bodyComponent);
if (footer) components.push({ type: 'FOOTER', text: footer });

// Quick replies, not URLs: tapping a quick reply sends an inbound message and
// reopens the 24-hour window. A URL button does not.
const buttons = (Array.isArray(b.buttons) ? b.buttons : [])
  .map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean).slice(0, 3)
  .map(function (t) { return { type: 'QUICK_REPLY', text: t.slice(0, 20) }; });
if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons });

const v = cfg.graph_version || 'v21.0';
return [{ json: {
  fail: '', name: name, token: cfg.access_token,
  url: 'https://graph.facebook.com/' + v + '/' + cfg.waba_id + '/message_templates',
  payload: {
    name: name,
    language: String(b.language || 'en_US'),
    category: category,
    // Let Meta re-file it rather than reject it outright when it disagrees
    // with our category - a rejection costs a day, a re-file costs nothing.
    allow_category_change: true,
    components: components
  }
} }];
"""

CHECK_CREATE_JS = r"""
const built = $('Build Template').first().json;
const res = $('Create Template').first().json || {};
if (res.error || !res.id) {
  const e = res.error || {};
  let msg = String(e.error_user_msg || e.message || 'the template was not created');
  if (/already exists/i.test(msg)) msg = 'A template with that name already exists.';
  return [{ json: { ok: false, error: msg.slice(0, 300) } }];
}
return [{ json: { ok: true, id: String(res.id), name: built.name,
                  status: String(res.status || 'PENDING'),
                  category: String(res.category || '') } }];
"""


def add_templates(b, list_output, create_output):
    """List and create WhatsApp message templates."""
    y = 2500
    b.node("Build Template List", CODE, {"jsCode": BUILD_LIST_JS}, 420, y, executeOnce=True)
    b.node("Templates Readable?", IF,
           {"conditions": cond_str("={{ $json.fail }}", "equals", ""), "options": {}}, 620, y)
    b.node("Fetch Templates", HTTP,
           {"method": "GET", "url": "={{ $json.url }}", "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $json.token }}"}]},
            "options": {"timeout": 20000}},
           820, y, onError="continueRegularOutput", executeOnce=True)
    b.node("Shape Templates", CODE, {"jsCode": SHAPE_LIST_JS}, 1020, y, executeOnce=True)
    b.node("Respond Templates", RESPOND, respond_json(), 1220, y)
    b.node("Respond Templates Error", RESPOND,
           respond_json("={{ JSON.stringify({ok:false, error: "
                        "$('Build Template List').first().json.fail}) }}", 400), 820, y + 200)

    b.link("Route Action", "Build Template List", list_output)
    b.link("Build Template List", "Templates Readable?")
    b.link("Templates Readable?", "Fetch Templates", 0)
    b.link("Templates Readable?", "Respond Templates Error", 1)
    b.link("Fetch Templates", "Shape Templates")
    b.link("Shape Templates", "Respond Templates")

    y2 = 2820
    b.node("Build Template", CODE, {"jsCode": BUILD_CREATE_JS}, 420, y2, executeOnce=True)
    b.node("Template Valid?", IF,
           {"conditions": cond_str("={{ $json.fail }}", "equals", ""), "options": {}}, 620, y2)
    b.node("Create Template", HTTP,
           {"method": "POST", "url": "={{ $json.url }}", "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $json.token }}"},
                {"name": "Content-Type", "value": "application/json"}]},
            "sendBody": True, "contentType": "json", "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.payload) }}", "options": {"timeout": 20000}},
           820, y2, onError="continueRegularOutput", executeOnce=True)
    b.node("Check Template", CODE, {"jsCode": CHECK_CREATE_JS}, 1020, y2, executeOnce=True)
    b.node("Respond Template", RESPOND, respond_json(), 1220, y2)
    b.node("Respond Template Error", RESPOND,
           respond_json("={{ JSON.stringify({ok:false, error: "
                        "$('Build Template').first().json.fail}) }}", 400), 820, y2 + 200)

    b.link("Route Action", "Build Template", create_output)
    b.link("Build Template", "Template Valid?")
    b.link("Template Valid?", "Create Template", 0)
    b.link("Template Valid?", "Respond Template Error", 1)
    b.link("Create Template", "Check Template")
    b.link("Check Template", "Respond Template")
