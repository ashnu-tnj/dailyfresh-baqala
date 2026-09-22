'use strict';
/* DailyFresh shop console.
 *
 * Thin server on purpose: it holds no n8n credentials and no business rules. All
 * reads and writes go through one authenticated n8n webhook (the Console API),
 * which decides what the console is allowed to change. This server only does
 * three things n8n cannot: serve the PWA, keep a signed session, and hold Web
 * Push subscriptions.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const metaRoutes = require('./meta');

const PORT = Number(process.env.PORT || 8082);
const CONSOLE_API = (process.env.CONSOLE_API_URL || '').replace(/\/+$/, '');
const CONSOLE_KEY = process.env.CONSOLE_API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://dailyfresh.aflatus.com').replace(/\/+$/, '');
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_CONFIG_ID = process.env.META_CONFIG_ID || '';
const META_HOSTED_SIGNUP_URL = process.env.META_HOSTED_SIGNUP_URL || '';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@aflatus.com';

for (const [name, value] of [['CONSOLE_API_URL', CONSOLE_API], ['CONSOLE_API_KEY', CONSOLE_KEY],
                             ['SESSION_SECRET', SESSION_SECRET], ['ADMIN_TOKEN', ADMIN_TOKEN]]) {
  if (!value) {
    console.error('FATAL: %s is not set. Copy .env.example to .env and fill it in.', name);
    process.exit(1);
  }
}
const pushReady = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushReady) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
else console.warn('Push disabled: VAPID keys not set (run `npm run vapid`).');

fs.mkdirSync(DATA_DIR, { recursive: true });
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);           // atomic, so a crash mid-write cannot truncate
}

// ---------------------------------------------------------------- sessions
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function makeSession(phone) {
  const body = Buffer.from(JSON.stringify({
    phone: phone, exp: Date.now() + SESSION_DAYS * 864e5
  })).toString('base64url');
  return body + '.' + sign(body);
}
function readSession(raw) {
  if (!raw || raw.indexOf('.') < 0) return null;
  const [body, mac] = raw.split('.');
  const expected = sign(body);
  // timingSafeEqual throws on length mismatch, so guard first.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return (s && s.exp > Date.now()) ? s : null;
  } catch (e) { return null; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function auth(req, res, next) {
  // Demo mode: allow testing without login
  if (process.env.DEMO_MODE === 'true') {
    req.phone = process.env.DEMO_PHONE || '+971502605763';
    return next();
  }
  const s = readSession(parseCookies(req.headers.cookie).df_session);
  if (!s) return res.status(401).json({ error: 'not signed in' });
  req.phone = s.phone;
  next();
}

// ---------------------------------------------------------------- n8n bridge
async function callConsoleApi(action, extra) {
  const res = await fetch(CONSOLE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: CONSOLE_KEY, action: action }, extra || {})),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { ok: false, error: 'bad response from n8n' }; }
  return { status: res.status, body: body };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const api = express.Router();

api.get('/health', (req, res) => res.json({
  ok: true, push: pushReady, subscriptions: readJson(SUBS_FILE, []).length,
  uptime: Math.round(process.uptime())
}));

api.get('/config', (req, res) => res.json({
  vapidPublicKey: pushReady ? VAPID_PUBLIC : null,
  signedIn: process.env.DEMO_MODE === 'true' || !!readSession(parseCookies(req.headers.cookie).df_session)
}));

// ---------------------------------------------------------------- login
// Rate limited per phone: the code itself is only 6 digits, so the number of
// guesses matters more than their quality. n8n counts attempts too; this stops
// the requests before they ever get there.
const attempts = new Map();
function throttle(keyName, limit, windowMs) {
  const now = Date.now();
  const rec = attempts.get(keyName);
  if (!rec || now > rec.reset) { attempts.set(keyName, { n: 1, reset: now + windowMs }); return true; }
  rec.n += 1;
  return rec.n <= limit;
}

api.post('/login/request', async (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (!throttle('req:' + phone, 5, 15 * 60000)) {
    return res.status(429).json({ error: 'too many code requests, wait a few minutes' });
  }
  try {
    const r = await callConsoleApi('login_request', { phone: phone });
    if (r.body && r.body.ok) return res.json({ ok: true });
    return res.status(r.status === 200 ? 400 : r.status).json({ error: (r.body && r.body.error) || 'could not send code' });
  } catch (e) {
    return res.status(502).json({ error: 'could not reach the shop service' });
  }
});

api.post('/login/verify', async (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  const code = String((req.body || {}).code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  if (!throttle('ver:' + phone, 10, 15 * 60000)) {
    return res.status(429).json({ error: 'too many attempts, wait a few minutes' });
  }
  try {
    const r = await callConsoleApi('login_verify', { phone: phone, code: code });
    if (!(r.body && r.body.ok)) {
      return res.status(401).json({ error: (r.body && r.body.error) || 'wrong code' });
    }
    res.setHeader('Set-Cookie', 'df_session=' + makeSession(phone) +
      '; HttpOnly; SameSite=Lax; Path=' + (BASE_PATH || '/') +
      '; Max-Age=' + (SESSION_DAYS * 86400) + (process.env.INSECURE_COOKIE ? '' : '; Secure'));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: 'could not reach the shop service' });
  }
});

api.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'df_session=; HttpOnly; SameSite=Lax; Path=' + (BASE_PATH || '/') + '; Max-Age=0');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- data
api.get('/state', auth, async (req, res) => {
  try {
    const r = await callConsoleApi('state');
    if (!(r.body && r.body.ok)) return res.status(502).json({ error: 'shop service unavailable' });
    res.json(r.body);
  } catch (e) { res.status(502).json({ error: 'could not reach the shop service' }); }
});

api.post('/update', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await callConsoleApi('update', Object.assign({}, b, { by: req.phone }));
    res.status(r.body && r.body.ok ? 200 : 400).json(r.body);
  } catch (e) { res.status(502).json({ error: 'could not reach the shop service' }); }
});

// ------------------------------------------------------- staff WhatsApp
// Replying and template management both run through n8n, which holds the
// access token. Nothing here ever touches Graph directly.
api.post('/wa-send', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await callConsoleApi('wa_send', { phone: b.phone, text: b.text, by: req.phone });
    res.status(r.body && r.body.ok ? 200 : 400).json(r.body);
  } catch (e) { res.status(502).json({ error: 'could not reach the shop service' }); }
});

api.get('/templates', auth, async (req, res) => {
  try {
    const r = await callConsoleApi('templates');
    res.status(r.body && r.body.ok ? 200 : 400).json(r.body);
  } catch (e) { res.status(502).json({ error: 'could not reach the shop service' }); }
});

api.post('/templates', auth, async (req, res) => {
  const b = req.body || {};
  try {
    const r = await callConsoleApi('template_create', {
      name: b.name, category: b.category, language: b.language,
      header_text: b.header_text, body_text: b.body_text,
      footer_text: b.footer_text, buttons: b.buttons, examples: b.examples
    });
    res.status(r.body && r.body.ok ? 200 : 400).json(r.body);
  } catch (e) { res.status(502).json({ error: 'could not reach the shop service' }); }
});

// ---------------------------------------------------------------- push
api.post('/subscribe', auth, (req, res) => {
  const sub = (req.body || {}).subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  const list = readJson(SUBS_FILE, []);
  const i = list.findIndex(x => x.subscription.endpoint === sub.endpoint);
  const rec = { subscription: sub, phone: req.phone, createdAt: new Date().toISOString() };
  if (i >= 0) list[i] = rec; else list.push(rec);
  writeJson(SUBS_FILE, list);
  res.json({ ok: true, total: list.length });
});

api.post('/unsubscribe', (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  writeJson(SUBS_FILE, readJson(SUBS_FILE, []).filter(x => x.subscription.endpoint !== endpoint));
  res.json({ ok: true });
});

async function broadcast(payload) {
  if (!pushReady) return { sent: 0, total: 0, reason: 'push not configured' };
  const list = readJson(SUBS_FILE, []);
  let sent = 0;
  const gone = [];
  await Promise.all(list.map(async rec => {
    try {
      await webpush.sendNotification(rec.subscription, JSON.stringify(payload), { TTL: 300, urgency: 'high' });
      sent += 1;
    } catch (e) {
      // 404/410 mean the browser threw the subscription away; drop it rather
      // than retrying it forever.
      if (e.statusCode === 404 || e.statusCode === 410) gone.push(rec.subscription.endpoint);
    }
  }));
  if (gone.length) writeJson(SUBS_FILE, readJson(SUBS_FILE, []).filter(x => gone.indexOf(x.subscription.endpoint) < 0));
  return { sent: sent, total: list.length, dropped: gone.length };
}

// Called by the bot workflow, not by the browser.
api.post('/notify', async (req, res) => {
  const given = String(req.get('x-admin-token') || '');
  if (given.length !== ADMIN_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(given.padEnd(ADMIN_TOKEN.length, ' ')), Buffer.from(ADMIN_TOKEN))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const b = req.body || {};
  const result = await broadcast({
    title: String(b.title || 'DailyFresh'),
    body: String(b.body || ''),
    tag: String(b.tag || 'dailyfresh'),
    requireInteraction: !!b.requireInteraction,
    url: String(b.url || './')
  });
  res.json(result);
});

api.post('/test-push', auth, async (req, res) => {
  res.json(await broadcast({ title: 'DailyFresh', body: 'Push is working on this device.', tag: 'test' }));
});

app.use((BASE_PATH || '') + '/api', api);

// Public Meta endpoints. Mounted ahead of the static handler and SPA fallback so
// the catch-all cannot swallow them.
app.use(BASE_PATH || '/', metaRoutes({
  appId: META_APP_ID, appSecret: META_APP_SECRET, configId: META_CONFIG_ID,
  publicBaseUrl: PUBLIC_BASE_URL + (BASE_PATH || ''), dataDir: DATA_DIR,
  graphVersion: GRAPH_VERSION, hostedSignupUrl: META_HOSTED_SIGNUP_URL,
  onboard: async (code) => {
    const r = await callConsoleApi('onboard', { code: code });
    return r.body || { ok: false, error: 'no response from the shop service' };
  }
}));

// ---------------------------------------------------------------- static
const WEB = path.join(__dirname, '..', 'web');
// index.html is read per request so a redeploy does not need a restart to show.
function sendIndex(req, res) {
  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  html = html.replace('<!--BASE-->', '<base href="' + (BASE_PATH || '') + '/">');
  res.type('html').send(html);
}
app.get((BASE_PATH || '') + '/', sendIndex);
// maxAge 0 rather than an hour: these files are the app itself, and a stale copy
// is indistinguishable from a broken deploy - a CSS fix sat unseen behind an
// hour of max-age once already. ETags still make the revalidation a 304, so the
// cost is one conditional request per file, not a re-download.
app.use(BASE_PATH || '/', express.static(WEB, { index: false, maxAge: 0, etag: true }));
app.get('*', (req, res, next) => {
  if (req.path.indexOf('/api/') >= 0) return next();
  sendIndex(req, res);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('dailyfresh-console listening on %d', PORT);
  console.log('  console api : %s', CONSOLE_API);
  console.log('  base path   : %s', BASE_PATH || '(root)');
  console.log('  push        : %s', pushReady ? 'enabled' : 'DISABLED (no VAPID keys)');
  console.log('  meta urls   : %s/connect | /connect/callback | /deauthorize | /datadeletion', PUBLIC_BASE_URL);
  console.log('  signed_request verification: %s',
    META_APP_SECRET ? 'enabled' : 'DISABLED (set META_APP_SECRET)');
});
