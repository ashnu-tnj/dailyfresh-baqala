#!/usr/bin/env python3
"""The `onboard` branch of the Console API.

Turns an Embedded Signup code into a working tenant:

  code -> business token -> which WhatsApp account? -> which phone number?
       -> subscribe this app to that account -> write the three values the bot needs

All of it happens inside n8n so the Meta app secret never leaves it - the console
container only ever forwards the code.

Subscribing the app to the WABA is the step that looks optional and is not: skip
it and the webhook is configured, the bot looks healthy, and not one message is
ever delivered.
"""
from wfkit import IF, CODE, HTTP, DATATABLE, RESPOND, cond_str, dt_upsert, respond_json

EXCHANGE_JS = r"""
const cfg = $('Auth & Route').first().json.cfg || {};
const code = String(($('Auth & Route').first().json.body || {}).code || '');
const v = cfg.graph_version || 'v21.0';
if (!code) return [{ json: { fail: 'no code supplied' } }];
if (!cfg.meta_app_id || !cfg.meta_app_secret) {
  return [{ json: { fail: 'meta_app_id / meta_app_secret are not set in df_config' } }];
}
return [{ json: {
  fail: '', v: v,
  url: 'https://graph.facebook.com/' + v + '/oauth/access_token' +
       '?client_id=' + encodeURIComponent(cfg.meta_app_id) +
       '&client_secret=' + encodeURIComponent(cfg.meta_app_secret) +
       '&code=' + encodeURIComponent(code)
} }];
"""

INSPECT_JS = r"""
const r = $('Exchange Code').first().json || {};
const token = r.access_token || '';
const v = $('Build Exchange').first().json.v;
if (!token) {
  const err = (r.error && r.error.message) || r.error || 'no access_token returned';
  return [{ json: { fail: 'code exchange failed: ' + String(err).slice(0, 200) } }];
}
// debug_token reports which WhatsApp accounts this token may act on.
return [{ json: { fail: '', token: token, v: v,
  url: 'https://graph.facebook.com/' + v + '/debug_token?input_token=' +
       encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token) } }];
"""

FIND_WABA_JS = r"""
const prev = $('Build Inspect').first().json;
if (prev.fail) return [{ json: { fail: prev.fail } }];
const d = (($('Inspect Token').first().json) || {}).data || {};
let waba = '';
for (const s of (d.granular_scopes || [])) {
  if (s.scope === 'whatsapp_business_management' || s.scope === 'whatsapp_business_messaging') {
    if (s.target_ids && s.target_ids.length) { waba = String(s.target_ids[0]); break; }
  }
}
if (!waba) return [{ json: { fail: 'that token is not scoped to a WhatsApp Business Account' } }];
return [{ json: { fail: '', token: prev.token, v: prev.v, waba_id: waba,
  url: 'https://graph.facebook.com/' + prev.v + '/' + waba +
       '/phone_numbers?access_token=' + encodeURIComponent(prev.token) } }];
"""

CHECK_JS = r"""
const prev = $('Find WABA').first().json;
if (prev.fail) return [{ json: { fail: prev.fail } }];
const list = (($('Read Phone Numbers').first().json) || {}).data || [];
if (!list.length) {
  // Coexistence often returns no number until the owner finishes on their handset.
  return [{ json: { fail: 'no phone number on that account yet - finish signup on the phone, then try again' } }];
}
const n = list[0];
return [{ json: { fail: '', token: prev.token, v: prev.v, waba_id: prev.waba_id,
  phone_number_id: String(n.id),
  display_phone_number: n.display_phone_number || '',
  verified_name: n.verified_name || '',
  subscribe_url: 'https://graph.facebook.com/' + prev.v + '/' + prev.waba_id + '/subscribed_apps' } }];
"""

ROWS_JS = r"""
const c = $('Check Onboard').first().json;
// One item per key; the Data Table node writes all three in a single pass.
return [
  { json: { config_key: 'access_token', value: c.token } },
  { json: { config_key: 'waba_id', value: c.waba_id } },
  { json: { config_key: 'phone_number_id', value: c.phone_number_id } }
];
"""

ERR_EXPR = ("={{ JSON.stringify({ok:false, error: "
            "($('Build Exchange').first().json.fail) || "
            "($('Check Onboard').isExecuted ? $('Check Onboard').first().json.fail : '') || "
            "'onboarding failed'}) }}")

OK_EXPR = ("={{ JSON.stringify({ok:true, "
           "waba_id: $('Check Onboard').first().json.waba_id, "
           "phone_number_id: $('Check Onboard').first().json.phone_number_id, "
           "number: $('Check Onboard').first().json.display_phone_number, "
           "name: $('Check Onboard').first().json.verified_name}) }}")


def add_onboard(b, route_output):
    """Attach the onboard branch to builder `b` at the given Route Action output."""
    y = 1700
    b.node("Build Exchange", CODE, {"jsCode": EXCHANGE_JS}, 420, y, executeOnce=True)
    b.node("Exchangeable?", IF,
           {"conditions": cond_str("={{ $json.fail }}", "equals", ""), "options": {}}, 620, y)
    b.node("Respond Onboard Error", RESPOND, respond_json(ERR_EXPR, 400), 820, y + 200)

    b.node("Exchange Code", HTTP,
           {"method": "GET", "url": "={{ $json.url }}", "options": {"timeout": 20000}},
           820, y, onError="continueRegularOutput", executeOnce=True)
    b.node("Build Inspect", CODE, {"jsCode": INSPECT_JS}, 1020, y, executeOnce=True)
    b.node("Inspect Token", HTTP,
           {"method": "GET", "url": "={{ $json.url }}", "options": {"timeout": 20000}},
           1220, y, onError="continueRegularOutput", executeOnce=True)
    b.node("Find WABA", CODE, {"jsCode": FIND_WABA_JS}, 1420, y, executeOnce=True)
    b.node("Read Phone Numbers", HTTP,
           {"method": "GET", "url": "={{ $json.url }}", "options": {"timeout": 20000}},
           1620, y, onError="continueRegularOutput", executeOnce=True)
    b.node("Check Onboard", CODE, {"jsCode": CHECK_JS}, 1820, y, executeOnce=True)
    b.node("Onboard OK?", IF,
           {"conditions": cond_str("={{ $json.fail }}", "equals", ""), "options": {}}, 2020, y)

    b.node("Subscribe App", HTTP,
           {"method": "POST", "url": "={{ $json.subscribe_url }}", "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $json.token }}"}]},
            "options": {"timeout": 20000}},
           2220, y - 60, onError="continueRegularOutput", executeOnce=True)

    # No executeOnce here: it must see all three items.
    b.node("Onboard Rows", CODE, {"jsCode": ROWS_JS}, 2420, y - 60)
    b.node("Write Onboard Config", DATATABLE, dt_upsert("df_config", "config_key"),
           2620, y - 60, onError="continueRegularOutput")
    b.node("Respond Onboard", RESPOND, respond_json(OK_EXPR), 2820, y - 60)

    b.link("Route Action", "Build Exchange", route_output)
    b.link("Build Exchange", "Exchangeable?")
    b.link("Exchangeable?", "Exchange Code", 0)
    b.link("Exchangeable?", "Respond Onboard Error", 1)
    b.link("Exchange Code", "Build Inspect")
    b.link("Build Inspect", "Inspect Token")
    b.link("Inspect Token", "Find WABA")
    b.link("Find WABA", "Read Phone Numbers")
    b.link("Read Phone Numbers", "Check Onboard")
    b.link("Check Onboard", "Onboard OK?")
    b.link("Onboard OK?", "Subscribe App", 0)
    b.link("Onboard OK?", "Respond Onboard Error", 1)
    b.link("Subscribe App", "Onboard Rows")
    b.link("Onboard Rows", "Write Onboard Config")
    b.link("Write Onboard Config", "Respond Onboard")
