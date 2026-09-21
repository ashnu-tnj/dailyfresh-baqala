'use strict';
/* The four public URLs the Meta app configuration asks for.
 *
 *   GET  /connect              Embedded Signup launcher
 *   GET  /connect/callback     OAuth Redirect URI
 *   POST /deauthorize          Deauthorize callback   (Meta -> us)
 *   POST /datadeletion         Data Deletion Request  (Meta -> us)
 *
 * The two POST endpoints are called by Meta's servers, not a browser, so they
 * are deliberately outside the session check. Meta authenticates itself with a
 * `signed_request` signed with the app secret - that signature IS the auth, so
 * it is verified rather than trusted, and a request that fails verification is
 * refused.
 */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Returns the payload object, or null when the signature does not check out. */
function verifySignedRequest(signed, appSecret) {
  if (!signed || !appSecret) return null;
  const parts = String(signed).split('.');
  if (parts.length !== 2) return null;
  const [sig, payload] = parts;
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (data.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
    return data;
  } catch (e) { return null; }
}

const page = (title, bodyHtml) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#2e7d32"><title>${title} — DailyFresh</title>
<style>
 :root{--green:#2e7d32;--ink:#16241a;--muted:#5d6b60;--line:#dfe5e0;--bg:#f6f8f6;--card:#fff}
 @media(prefers-color-scheme:dark){:root{--ink:#e7efe8;--muted:#9db0a2;--line:#2b352d;--bg:#111713;--card:#182019}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:640px;margin:0 auto;padding:2.5rem 1.25rem}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.75rem}
 h1{color:var(--green);font-size:1.4rem;margin:0 0 .25rem}
 h2{font-size:1rem;margin:1.75rem 0 .5rem}
 p{margin:.6rem 0}.muted{color:var(--muted)}.small{font-size:.9rem}
 code{background:rgba(127,127,127,.15);padding:.15rem .4rem;border-radius:5px;font-size:.9em;word-break:break-all}
 ol,ul{padding-left:1.25rem}li{margin:.35rem 0}
 .btn{display:inline-block;min-height:46px;line-height:46px;padding:0 1.25rem;background:var(--green);
      color:#fff;border:0;border-radius:10px;font-weight:600;text-decoration:none;cursor:pointer;font-size:1rem}
 .btn[disabled]{background:var(--muted);cursor:not-allowed}
 .note{border-left:4px solid var(--green);padding:.5rem 0 .5rem .9rem;margin:1.25rem 0}
 footer{margin-top:2rem;font-size:.85rem}
 a{color:var(--green)}
</style></head><body><div class="wrap"><div class="card">${bodyHtml}</div>
<footer class="muted small">DailyFresh is operated by AFLATUS OPC PVT LTD ·
 <a href="https://www.aflatus.com/privacypolicy/">Privacy policy</a> ·
 <a href="mailto:info@aflatus.com">info@aflatus.com</a></footer></div></body></html>`;

module.exports = function metaRoutes(opts) {
  const APP_ID = opts.appId || '';
  const APP_SECRET = opts.appSecret || '';
  const CONFIG_ID = opts.configId || '';
  // Meta will host the signup flow itself. Preferred over driving the JS SDK
  // ourselves: no SDK to load, no popup blockers, and it is the path Meta
  // supports. It returns the code to our redirect_uri as a normal query param.
  const HOSTED_SIGNUP = opts.hostedSignupUrl || '';
  const BASE = (opts.publicBaseUrl || '').replace(/\/+$/, '');
  const DATA_DIR = opts.dataDir;
  const GRAPH_VERSION = opts.graphVersion || 'v21.0';
  const LOG = path.join(DATA_DIR, 'meta-callbacks.json');

  const router = express.Router();
  // Meta posts these as application/x-www-form-urlencoded.
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));

  function record(kind, entry) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch (e) { list = []; }
    list.unshift(Object.assign({ kind: kind, at: new Date().toISOString() }, entry));
    // Keep it bounded - this is an audit trail, not a database.
    list = list.slice(0, 500);
    const tmp = LOG + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fs.renameSync(tmp, LOG);
  }

  // ---------------------------------------------------------- embedded signup
  router.get('/connect', (req, res) => {
    if (HOSTED_SIGNUP) {
      return res.type('html').send(page('Connect', `
      <h1>Connect your WhatsApp number</h1>
      <p>This links your WhatsApp Business number to DailyFresh so the ordering
         assistant can reply to your customers. You keep using WhatsApp on your
         phone exactly as you do now — your existing chats stay where they are.</p>
      <div class="note"><p class="small muted">Have ready: the Facebook account that
        manages your business, and the phone you use for customers. Meta will ask you
        to confirm that number.</p></div>
      <p><a class="btn" href="${HOSTED_SIGNUP}">Continue to Meta</a></p>
      <h2>What we get</h2>
      <ul class="small muted">
        <li>Permission to send and receive WhatsApp messages for your business</li>
        <li>Your WhatsApp Business account and phone number IDs</li>
        <li>Nothing from your personal Facebook profile</li>
      </ul>
      <p class="small muted">Meta runs the next screens. You will come back here when it is done.</p>`));
    }
    const ready = APP_ID && CONFIG_ID;
    const body = ready ? `
      <h1>Connect your WhatsApp number</h1>
      <p>This links your WhatsApp Business number to DailyFresh so the ordering
         assistant can reply to your customers. You keep using WhatsApp on your
         phone exactly as you do now.</p>
      <div class="note"><p class="small muted">You will need: your Meta Business account,
         the phone number you use for customers, and access to that number to confirm it.</p></div>
      <p><button class="btn" id="go">Connect with Facebook</button></p>
      <p id="status" class="muted small"></p>
      <h2>What we receive</h2>
      <ul class="small muted">
        <li>Permission to send and receive WhatsApp messages on your behalf</li>
        <li>Your WhatsApp Business account and phone number IDs</li>
        <li>Nothing from your personal Facebook profile</li>
      </ul>
      <script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
      <script>
        window.fbAsyncInit = function () {
          FB.init({ appId: ${JSON.stringify(APP_ID)}, cookie: true, xfbml: false, version: ${JSON.stringify(GRAPH_VERSION)} });
        };
        // Meta returns the exchange code on this channel, not in the callback.
        window.addEventListener('message', function (e) {
          if (!/facebook\\.com$/.test(new URL(e.origin).hostname)) return;
          try {
            var d = JSON.parse(e.data);
            if (d.type === 'WA_EMBEDDED_SIGNUP') {
              document.getElementById('status').textContent =
                d.event === 'FINISH' ? 'Connected. You can close this page.'
                                     : 'Signup ' + d.event + '.';
            }
          } catch (err) { /* not our message */ }
        });
        document.getElementById('go').addEventListener('click', function () {
          if (typeof FB === 'undefined') { document.getElementById('status').textContent = 'Still loading, try again in a moment.'; return; }
          FB.login(function (r) {
            document.getElementById('status').textContent =
              (r.authResponse && r.authResponse.code) ? 'Finishing up…' : 'Signup was cancelled.';
            if (r.authResponse && r.authResponse.code) {
              fetch('connect/callback?code=' + encodeURIComponent(r.authResponse.code), { method: 'POST' })
                .then(function () { document.getElementById('status').textContent = 'Connected. You can close this page.'; })
                .catch(function () { document.getElementById('status').textContent = 'Connected, but we could not confirm it. We will be in touch.'; });
            }
          }, {
            config_id: ${JSON.stringify(CONFIG_ID)},
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' }
          });
        });
      </script>` : `
      <h1>Connect your WhatsApp number</h1>
      <p>This page is reachable, but signup is not switched on yet.</p>
      <div class="note"><p class="small muted">Set <code>META_APP_ID</code> and
        <code>META_CONFIG_ID</code> on the console container to enable it. The
        Embedded Signup configuration ID comes from the Meta app, under
        WhatsApp &rsaquo; Embedded Signup.</p></div>`;
    res.type('html').send(page('Connect', body));
  });

  // ---------------------------------------------------------- redirect URI
  // Registered with Meta as the OAuth Redirect URI. Embedded Signup returns its
  // code over postMessage, so a browser landing here is the fallback path.
  router.all('/connect/callback', (req, res) => {
    const code = req.query.code || (req.body && req.body.code) || '';
    const error = req.query.error_description || req.query.error || '';
    if (code) record('oauth_code', { received: true, length: String(code).length });

    if (req.method === 'POST') return res.json({ ok: !!code });
    const body = error ? `
      <h1>Connection was not completed</h1>
      <p class="muted">${String(error).replace(/[<>&]/g, '')}</p>
      <p><a class="btn" href="../connect">Try again</a></p>` : code ? `
      <h1>Thank you — your number is connected</h1>
      <p>We have what we need. Our team will confirm once your assistant is live,
         usually the same day.</p>
      <p class="muted small">You can close this page.</p>` : `
      <h1>Nothing to confirm here</h1>
      <p class="muted">This page is the return address for WhatsApp signup. Start
         from <a href="../connect">the connect page</a>.</p>`;
    res.type('html').send(page('Connected', body));
  });

  // ---------------------------------------------------------- deauthorize
  router.post('/deauthorize', (req, res) => {
    const data = verifySignedRequest((req.body || {}).signed_request, APP_SECRET);
    if (!data) {
      record('deauthorize_rejected', { reason: APP_SECRET ? 'bad signature' : 'no app secret configured' });
      return res.status(400).json({ ok: false, error: 'invalid signed_request' });
    }
    // Deliberately does NOT switch anything off on its own: this endpoint is a
    // notification, and acting on it automatically would let a replayed or
    // mistaken call disable a live shop. A human reviews the log.
    record('deauthorize', { user_id: data.user_id || null, issued_at: data.issued_at || null });
    res.json({ ok: true });
  });

  router.get('/deauthorize', (req, res) => res.type('html').send(page('Deauthorize', `
    <h1>Deauthorize callback</h1>
    <p class="muted">This address is used by Meta to tell us when someone removes
       the DailyFresh app from their account. There is nothing to see here.</p>
    <p class="small muted">To disconnect your number, remove the app in your Meta
       Business settings, or email <a href="mailto:info@aflatus.com">info@aflatus.com</a>
       and we will do it for you.</p>`)));

  // ---------------------------------------------------------- data deletion
  router.post('/datadeletion', (req, res) => {
    const data = verifySignedRequest((req.body || {}).signed_request, APP_SECRET);
    if (!data) {
      record('deletion_rejected', { reason: APP_SECRET ? 'bad signature' : 'no app secret configured' });
      return res.status(400).json({ error: 'invalid signed_request' });
    }
    const code = crypto.randomBytes(8).toString('hex');
    record('deletion_request', { user_id: data.user_id || null, confirmation_code: code, status: 'received' });
    // Meta requires exactly this shape.
    res.json({
      url: BASE + '/datadeletion/status?code=' + code,
      confirmation_code: code
    });
  });

  router.get('/datadeletion', (req, res) => res.type('html').send(page('Data deletion', `
    <h1>Delete your data</h1>
    <p>DailyFresh is the WhatsApp ordering assistant used by shops to take orders
       from their customers. If you have messaged a shop through it, we hold:</p>
    <ul>
      <li>your WhatsApp number and the name on your WhatsApp profile</li>
      <li>the delivery address and location pin you gave the shop</li>
      <li>your orders, and the messages in the ordering conversation</li>
    </ul>
    <h2>How to ask for deletion</h2>
    <ol>
      <li>Email <a href="mailto:info@aflatus.com">info@aflatus.com</a> from any address,
          or message the shop's WhatsApp number, with the words <strong>delete my data</strong>.</li>
      <li>Tell us the WhatsApp number you used, so we can find the right records.</li>
      <li>We delete everything above within 30 days and confirm when it is done.</li>
    </ol>
    <div class="note"><p class="small muted">Orders already delivered may be kept in the
      shop's own accounting records, which are theirs rather than ours. We will tell you
      if that applies to you.</p></div>
    <p class="small muted">If you arrived here from Facebook's app settings, your request
       was received automatically and you were given a confirmation code.</p>`)));

  router.get('/datadeletion/status', (req, res) => {
    const code = String(req.query.code || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
    let found = null;
    try {
      found = JSON.parse(fs.readFileSync(LOG, 'utf8'))
        .find(e => e.kind === 'deletion_request' && e.confirmation_code === code) || null;
    } catch (e) { found = null; }
    const body = found ? `
      <h1>Deletion request received</h1>
      <p>Confirmation code <code>${code}</code></p>
      <p>Received ${new Date(found.at).toUTCString()}. Status: <strong>${found.status}</strong>.</p>
      <p class="muted small">We complete deletion within 30 days. Questions go to
         <a href="mailto:info@aflatus.com">info@aflatus.com</a> — quote the code above.</p>` : `
      <h1>We could not find that request</h1>
      <p class="muted">Check the confirmation code, or email
         <a href="mailto:info@aflatus.com">info@aflatus.com</a> and we will look it up.</p>`;
    res.type('html').send(page('Deletion status', body));
  });

  // A quick way to see the URLs are live and whether signature checking is on.
  router.get('/meta/health', (req, res) => res.json({
    ok: true,
    signed_request_verification: APP_SECRET ? 'enabled' : 'DISABLED - META_APP_SECRET not set',
    embedded_signup: HOSTED_SIGNUP ? 'meta-hosted'
      : (APP_ID && CONFIG_ID) ? 'js-sdk' : 'not configured',
    urls: {
      embedded_signup: BASE + '/connect',
      redirect_uri: BASE + '/connect/callback',
      deauthorize: BASE + '/deauthorize',
      data_deletion: BASE + '/datadeletion'
    }
  }));

  return router;
};
