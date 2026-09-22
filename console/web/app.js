'use strict';
/* DailyFresh console UI. No framework: the whole thing is four lists and a few
   buttons, and a build step would cost more than it saves. */

const $ = sel => document.querySelector(sel);
const api = p => new URL(p, document.baseURI).toString();

let STATE = null;
let TAB = 'orders';
let ORDER_FILTER = 'new';
let POLL = null;

// ---------------------------------------------------------------- helpers
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function req(path, options) {
  const res = await fetch(api(path), Object.assign({
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin'
  }, options || {}));
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty body is fine */ }
  if (!res.ok) throw new Error((body && body.error) || ('request failed (' + res.status + ')'));
  return body;
}

function money(n) {
  const cur = (STATE && STATE.shop && STATE.shop.currency) || 'AED';
  return cur + ' ' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}

function whenText(iso) {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  return t.toLocaleDateString();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- login
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  stopPolling();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const phone = $('#phone').value.trim();
  const btn = $('#send-code');
  $('#login-error').hidden = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await req('api/login/request', { method: 'POST', body: JSON.stringify({ phone }) });
    $('#code-target').textContent = phone;
    $('#step-phone').hidden = true;
    $('#step-code').hidden = false;
    $('#code').focus();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send me a code';
  }
});

$('#verify').addEventListener('click', async () => {
  const phone = $('#phone').value.trim();
  const code = $('#code').value.trim();
  $('#login-error').hidden = true;
  try {
    await req('api/login/verify', { method: 'POST', body: JSON.stringify({ phone, code }) });
    $('#login').hidden = true;
    $('#app').hidden = false;
    await load();
    startPolling();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});

$('#back-to-phone').addEventListener('click', () => {
  $('#step-code').hidden = true;
  $('#step-phone').hidden = false;
  $('#login-error').hidden = true;
});

$('#logout').addEventListener('click', async () => {
  await req('api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------------------------------------------------------------- data
async function load() {
  try {
    STATE = await req('api/state');
    render();
  } catch (err) {
    if (/not signed in/i.test(err.message)) return showLogin();
    toast(err.message, true);
  }
}

async function update(payload, okMessage) {
  try {
    await req('api/update', { method: 'POST', body: JSON.stringify(payload) });
    if (okMessage) toast(okMessage);
    await load();
    return true;
  } catch (err) {
    toast(err.message, true);
    await load();
    return false;
  }
}

function startPolling() {
  stopPolling();
  // Push is the fast path; this is only so a screen left open does not go stale.
  POLL = setInterval(() => { if (!document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}
function stopPolling() { if (POLL) clearInterval(POLL); POLL = null; }

// ---------------------------------------------------------------- render
function render() {
  if (!STATE) return;
  const shop = STATE.shop || {};
  $('#shop-name').textContent = shop.business_name || 'DailyFresh';
  $('#shop-status').textContent = (shop.accepting_orders ? 'Taking orders' : 'Orders paused') +
    ' · ' + (shop.open_time || '') + '–' + (shop.close_time || '');

  const newOrders = (STATE.orders || []).filter(o => o.status === 'new').length;
  setBadge('#badge-orders', newOrders);
  setBadge('#badge-chats', (STATE.handoffs || []).length);

  renderOrders();
  renderChats();
  renderPrices();

  $('#accepting').checked = !!shop.accepting_orders;
  if (document.activeElement !== $('#fee')) $('#fee').value = shop.delivery_fee;
  if (document.activeElement !== $('#minorder')) $('#minorder').value = shop.min_order_value;
}

function setBadge(sel, n) {
  const el = $(sel);
  el.textContent = n;
  el.hidden = !n;
}

function renderOrders() {
  const all = STATE.orders || [];
  const rows = ORDER_FILTER === 'all' ? all : all.filter(o => o.status === ORDER_FILTER);
  const box = $('#orders');
  if (!rows.length) {
    box.innerHTML = '<p class="empty">No ' + esc(ORDER_FILTER === 'all' ? '' : ORDER_FILTER) + ' orders.</p>';
    return;
  }
  box.innerHTML = rows.map(o => {
    const acts = [];
    if (o.status === 'new') {
      acts.push('<button class="go" data-order="' + esc(o.order_id) + '" data-status="accepted">Accept</button>');
      acts.push('<button class="no" data-order="' + esc(o.order_id) + '" data-status="rejected">Reject</button>');
    } else if (o.status === 'accepted') {
      acts.push('<button class="go" data-order="' + esc(o.order_id) + '" data-status="delivered">Mark delivered</button>');
    }
    if (o.map_link) acts.push('<a href="' + esc(o.map_link) + '" target="_blank" rel="noopener">Map</a>');
    if (o.customer_phone) {
      acts.push('<a href="https://wa.me/' + esc(String(o.customer_phone).replace(/[^0-9]/g, '')) +
                '" target="_blank" rel="noopener">WhatsApp</a>');
    }
    return '<article class="item is-' + esc(o.status) + '">' +
      '<div class="row between"><h3>' + esc(o.customer_name || 'Customer') + '</h3>' +
      '<span class="total">' + esc(money(o.total)) + '</span></div>' +
      '<p class="meta">' + esc(o.order_id) + ' · ' + esc(whenText(o.created_at)) +
      ' · <span class="status-pill">' + esc(o.payment_mode || 'COD') + '</span></p>' +
      '<p class="items-text">' + esc(o.items_text || '') + '</p>' +
      '<p class="meta">' + esc(o.address_text || 'No address') + '</p>' +
      '<div class="actions">' + acts.join('') + '</div>' +
      '</article>';
  }).join('');
}

function renderChats() {
  const rows = STATE.handoffs || [];
  const box = $('#chats');
  if (!rows.length) {
    box.innerHTML = '<p class="empty">Nobody is waiting.</p>';
    return;
  }
  box.innerHTML = rows.map(h => {
    const digits = String(h.customer_phone || '').replace(/[^0-9]/g, '');
    return '<article class="item is-new">' +
      '<div class="row between"><h3>' + esc(h.customer_name || h.customer_phone || 'Customer') + '</h3>' +
      '<span class="meta">' + esc(whenText(h.last_message_at || h.opened_at)) + '</span></div>' +
      '<p class="meta">' + esc(h.customer_phone || '') + '</p>' +
      '<p class="items-text">' + esc(h.last_message_text || '') + '</p>' +
      '<div class="reply">' +
      '<textarea rows="2" data-reply-to="' + esc(digits) + '" maxlength="1024" ' +
      'placeholder="Write a reply…" aria-label="Reply to ' +
      esc(h.customer_name || 'customer') + '"></textarea>' +
      '<button class="go" data-send="' + esc(digits) + '">Send</button>' +
      '</div>' +
      '<div class="actions">' +
      '<a href="https://wa.me/' + esc(digits) + '" target="_blank" rel="noopener">Open in WhatsApp</a>' +
      '<button data-handoff="' + esc(h.handoff_id) + '">Mark handled</button>' +
      '</div></article>';
  }).join('');
}

function renderPrices() {
  const q = $('#search').value.trim().toLowerCase();
  const rows = (STATE.catalog || []).filter(i => {
    if (!q) return true;
    return (i.item_name + ' ' + (i.aliases || '') + ' ' + i.category).toLowerCase().indexOf(q) >= 0;
  });
  const box = $('#prices');
  if (!rows.length) { box.innerHTML = '<p class="empty">No matching items.</p>'; return; }
  box.innerHTML = rows.map(i => {
    const oos = i.out_of_stock === true || String(i.out_of_stock) === 'true';
    return '<article class="item">' +
      '<div class="price-row">' +
      '<div><h3 class="' + (oos ? 'oos' : '') + '">' + esc(i.item_name) + ' ' + esc(i.pack_label || '') + '</h3>' +
      '<p class="meta">' + esc(i.category) + ' · ' + esc(i.item_code) + '</p></div>' +
      '<input type="number" step="0.25" min="0" inputmode="decimal" value="' + esc(i.price) +
      '" data-price="' + esc(i.item_code) + '" aria-label="Price for ' + esc(i.item_name) + '">' +
      '</div>' +
      '<div class="row between" style="margin-top:.6rem">' +
      '<span class="meta">' + (oos ? 'Out of stock' : 'In stock') + '</span>' +
      '<label class="switch"><input type="checkbox" data-stock="' + esc(i.item_code) + '"' +
      (oos ? '' : ' checked') + '><span></span></label>' +
      '</div></article>';
  }).join('');
}

// ---------------------------------------------------------------- events
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    TAB = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('is-active', b === btn));
    ['orders', 'chats', 'prices', 'templates', 'settings'].forEach(name => {
      $('#panel-' + name).hidden = name !== TAB;
    });
    // Templates come from Graph, not from the state payload, so they are
    // fetched the first time the tab is opened.
    if (TAB === 'templates' && TEMPLATES === null) loadTemplates();
  });
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    ORDER_FILTER = chip.dataset.filter;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-active', c === chip));
    renderOrders();
  });
});

$('#orders').addEventListener('click', e => {
  const btn = e.target.closest('button[data-order]');
  if (!btn) return;
  btn.disabled = true;
  update({ target: 'order', order_id: btn.dataset.order, status: btn.dataset.status },
         'Order ' + btn.dataset.status);
});

$('#chats').addEventListener('click', async e => {
  const send = e.target.closest('button[data-send]');
  if (send) {
    const box = $('#chats').querySelector('textarea[data-reply-to="' + send.dataset.send + '"]');
    const text = box ? box.value.trim() : '';
    if (!text) return toast('Nothing to send', true);
    send.disabled = true;
    try {
      await req('api/wa-send', {
        method: 'POST',
        body: JSON.stringify({ phone: send.dataset.send, text: text })
      });
      // Clear it here rather than on the next load: a re-render would wipe a
      // half-typed reply in another card.
      if (box) box.value = '';
      toast('Sent on WhatsApp');
    } catch (err) {
      toast(err.message, true);
    }
    send.disabled = false;
    return;
  }
  const btn = e.target.closest('button[data-handoff]');
  if (!btn) return;
  btn.disabled = true;
  update({ target: 'handoff', handoff_id: btn.dataset.handoff }, 'Marked handled');
});

// ---------------------------------------------------------------- templates
let TEMPLATES = null;

async function loadTemplates() {
  const box = $('#templates');
  box.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const r = await req('api/templates');
    TEMPLATES = r.templates || [];
    renderTemplates();
  } catch (err) {
    box.innerHTML = '<p class="empty">' + esc(err.message) + '</p>';
  }
}

function renderTemplates() {
  const box = $('#templates');
  if (!TEMPLATES || !TEMPLATES.length) {
    box.innerHTML = '<p class="empty">No templates yet.</p>';
    return;
  }
  box.innerHTML = TEMPLATES.map(t => {
    const state = String(t.status || '').toUpperCase();
    const cls = state === 'APPROVED' ? 'ok' : state === 'REJECTED' ? 'bad' : 'wait';
    return '<article class="item">' +
      '<div class="row between"><h3>' + esc(t.name) + '</h3>' +
      '<span class="status-pill is-' + cls + '">' + esc(state || 'UNKNOWN') + '</span></div>' +
      '<p class="meta">' + esc(t.category || '') + ' · ' + esc(t.language || '') + '</p>' +
      '<p class="items-text">' + esc(t.body || '') + '</p>' +
      (t.buttons && t.buttons.length
        ? '<p class="meta">Buttons: ' + esc(t.buttons.join(' · ')) + '</p>' : '') +
      (t.rejected_reason
        ? '<p class="meta error-text">Rejected: ' + esc(t.rejected_reason) + '</p>' : '') +
      '</article>';
  }).join('');
}

$('#new-template').addEventListener('click', () => {
  const form = $('#template-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#t-name').focus();
});
$('#cancel-template').addEventListener('click', () => { $('#template-form').hidden = true; });

$('#template-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#submit-template');
  btn.disabled = true;
  try {
    const r = await req('api/templates', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#t-name').value,
        category: $('#t-category').value,
        language: $('#t-language').value,
        header_text: $('#t-header').value,
        body_text: $('#t-body').value,
        footer_text: $('#t-footer').value,
        buttons: $('#t-buttons').value.split(',').map(x => x.trim()).filter(Boolean)
      })
    });
    toast('Sent to WhatsApp — status ' + (r.status || 'PENDING'));
    $('#template-form').reset();
    $('#template-form').hidden = true;
    await loadTemplates();
  } catch (err) {
    toast(err.message, true);
  }
  btn.disabled = false;
});

$('#prices').addEventListener('change', e => {
  const price = e.target.closest('input[data-price]');
  if (price) {
    const v = Number(price.value);
    if (!isFinite(v) || v <= 0) { toast('Price must be more than zero', true); return load(); }
    return update({ target: 'item', item_code: price.dataset.price, price: v }, 'Price updated');
  }
  const stock = e.target.closest('input[data-stock]');
  if (stock) {
    return update({ target: 'item', item_code: stock.dataset.stock, out_of_stock: !stock.checked },
                  stock.checked ? 'Back in stock' : 'Marked out of stock');
  }
});

$('#search').addEventListener('input', renderPrices);
$('#refresh').addEventListener('click', load);

$('#accepting').addEventListener('change', e => {
  update({ target: 'config', config_key: 'accepting_orders', value: e.target.checked ? 'true' : 'false' },
         e.target.checked ? 'Taking orders' : 'Orders paused');
});
$('#save-fee').addEventListener('click', () =>
  update({ target: 'config', config_key: 'delivery_fee', value: $('#fee').value }, 'Delivery fee saved'));
$('#save-min').addEventListener('click', () =>
  update({ target: 'config', config_key: 'min_order_value', value: $('#minorder').value }, 'Minimum order saved'));

// ---------------------------------------------------------------- push
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function pushStatus() {
  const el = $('#push-state');
  const btn = $('#enable-push');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.textContent = 'This browser cannot show notifications.';
    btn.hidden = true; return;
  }
  if (Notification.permission === 'denied') {
    el.textContent = 'Blocked in browser settings — allow notifications for this site.';
    btn.hidden = true; return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { el.textContent = 'On for this device.'; btn.hidden = true; }
  else { el.textContent = 'Off — you will not hear about new orders.'; btn.hidden = false; }
}

$('#enable-push').addEventListener('click', async () => {
  try {
    const cfg = await req('api/config');
    if (!cfg.vapidPublicKey) return toast('Push is not configured on the server', true);
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('Notifications not allowed', true);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey)
    });
    await req('api/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
    toast('Notifications on');
    pushStatus();
  } catch (err) { toast(err.message, true); }
});

$('#test-push').addEventListener('click', async () => {
  try {
    const r = await req('api/test-push', { method: 'POST' });
    toast(r.sent ? ('Sent to ' + r.sent + ' device(s)') : 'No devices subscribed', !r.sent);
  } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(api('sw.js')).catch(() => {});
  }
  try {
    const cfg = await req('api/config');
    if (!cfg.signedIn) return showLogin();
    $('#app').hidden = false;
    await load();
    startPolling();
    pushStatus();
  } catch (e) {
    showLogin();
  }
})();
