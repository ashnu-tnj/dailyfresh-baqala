#!/usr/bin/env node
/* Local conversation harness for the DailyFresh engine.
 *
 *   node n8n/test-engine.js            run the scenarios, print PASS/FAIL
 *   node n8n/test-engine.js --show     also print the full chat transcript
 *
 * It fakes the four things n8n would supply (config, catalogue, customer row,
 * session row) and keeps them in memory between turns, so a scenario exercises
 * the real state machine end to end.
 */
var E = require('./engine.js');
var fs = require('fs');
var path = require('path');

var SHOW = process.argv.indexOf('--show') >= 0;
var HERE = __dirname;

var configRows = JSON.parse(fs.readFileSync(path.join(HERE, 'seed', 'df_config.json'), 'utf8')).rows;
var catalogRows = JSON.parse(fs.readFileSync(path.join(HERE, 'seed', 'df_catalog.seed.json'), 'utf8')).rows;

// Tuesday 2026-09-22 10:00 UTC == 14:00 Gulf, inside 08:00-22:00.
var T0 = '2026-09-22T10:00:00.000Z';

function Shop(overrides) {
  this.config = configRows.map(function (r) {
    var c = { config_key: r.config_key, value: r.value };
    if (overrides && overrides[r.config_key] !== undefined) c.value = overrides[r.config_key];
    return c;
  });
  this.catalog = JSON.parse(JSON.stringify(catalogRows));
  this.sessions = {};
  this.customers = {};
  this.orders = [];
  this.handoffs = [];
  this.events = [];
  this.now = T0;
}

Shop.prototype.send = function (phone, msg, opts) {
  opts = opts || {};
  var inbound = {
    phone: phone, wa_id: phone, profile_name: opts.profile || 'Ahmed',
    message_id: opts.mid || ('wamid.' + Math.random().toString(36).slice(2)),
    text: opts.tap ? '' : (msg || ''), reply_id: opts.tap ? msg : '',
    latitude: opts.lat, longitude: opts.lng,
    msg_type: opts.type || (opts.tap ? 'interactive'
               : (opts.lat !== undefined ? 'location' : 'text'))
  };
  var r = E.runEngine({
    now: opts.now || this.now,
    inbound: inbound,
    config: this.config,
    catalog: this.catalog,
    customer: this.customers[phone] || null,
    session: this.sessions[phone] || null,
    llm: opts.llm || null
  });
  if (!r.duplicate) {
    this.sessions[phone] = r.session;
    if (r.customer) this.customers[phone] = r.customer;
    if (r.order) this.orders.push(r.order);
    if (r.handoff) this.handoffs.push(r.handoff);
    this.events.push(r.event);
  }
  if (SHOW) print(phone, inbound, r);
  return r;
};

function print(phone, inb, r) {
  var who = inb.reply_id ? '[tap ' + inb.reply_id + ']' : (inb.latitude !== undefined && inb.latitude !== null ? '[location]' : inb.text);
  console.log('\n  │ ' + phone + ' > ' + who);
  if (r.duplicate) { console.log('  │ (duplicate ignored)'); return; }
  var s = r.send;
  if (!s) { console.log('  │ bot: (silent)'); return; }
  console.log('  │ bot [' + s.kind + ']: ' + String(s.body || '').replace(/\n/g, '\n  │        '));
  if (s.buttons) console.log('  │   buttons: ' + s.buttons.map(function (b) { return '[' + b.title + ']'; }).join(' '));
  if (s.sections) {
    s.sections.forEach(function (sec) {
      console.log('  │   -- ' + sec.title);
      sec.rows.forEach(function (row) { console.log('  │      * ' + row.title + (row.description ? '  (' + row.description + ')' : '')); });
    });
  }
}

// ------------------------------------------------------------------ asserts
var pass = 0, fail = 0, failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' -- ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' -- ' + detail : '')); }
}
function lastBody(r) { return (r.send && r.send.body) || ''; }
function rowIds(r) {
  var ids = [];
  ((r.send && r.send.sections) || []).forEach(function (s) { s.rows.forEach(function (x) { ids.push(x.id); }); });
  return ids;
}
function btnIds(r) { return ((r.send && r.send.buttons) || []).map(function (b) { return b.id; }); }

// ------------------------------------------------------------------ limits
function checkLimits(label, r) {
  var s = r.send;
  if (!s) return;
  var ok = true, why = '';
  if ((s.body || '').length > 1024) { ok = false; why = 'body ' + s.body.length; }
  if (s.buttons && s.buttons.length > 3) { ok = false; why = 'buttons ' + s.buttons.length; }
  if (s.buttons) s.buttons.forEach(function (b) { if (b.title.length > 20) { ok = false; why = 'btn "' + b.title + '" ' + b.title.length; } });
  if (s.sections) {
    var n = 0;
    s.sections.forEach(function (sec) {
      if (sec.title.length > 24) { ok = false; why = 'section title ' + sec.title.length; }
      sec.rows.forEach(function (x) {
        n++;
        if (x.title.length > 24) { ok = false; why = 'row title "' + x.title + '" ' + x.title.length; }
        if ((x.description || '').length > 72) { ok = false; why = 'row desc ' + x.description.length; }
      });
    });
    if (n > 10) { ok = false; why = 'rows ' + n; }
  }
  if (!ok) check('Meta limits: ' + label, false, why);
  return ok;
}

console.log('\n=== 1. New customer, guided tap-only order ===');
(function () {
  var shop = new Shop();
  var p = '+971500000001';
  var r = shop.send(p, 'hi');
  checkLimits('greeting', r);
  check('greeting offers 2 buttons', btnIds(r).join(',') === 'order_now,staff', btnIds(r).join(','));

  r = shop.send(p, 'order_now', { tap: true });
  check('asks for location natively', r.send.kind === 'location_request', r.send.kind);

  r = shop.send(p, '', { lat: 25.31, lng: 55.42 });
  check('accepts in-range pin', /type your address/i.test(lastBody(r)), lastBody(r).slice(0, 60));

  r = shop.send(p, 'Villa 12, Al Nahda Building, Street 7, near Sahara Centre');
  check('reads the address back', btnIds(r).join(',') === 'addr_ok,addr_fix', btnIds(r).join(','));

  r = shop.send(p, 'addr_ok', { tap: true });
  check('offers profile name as one tap', btnIds(r).join(',') === 'name_ok,name_new', btnIds(r).join(','));

  r = shop.send(p, 'name_ok', { tap: true });
  checkLimits('categories', r);
  var ids = rowIds(r);
  check('category list within 10 rows', ids.length <= 10, String(ids.length));
  check('shows all 6 Baqala sections', ids.filter(function (x) { return x.indexOf('cat:') === 0; }).length === 6, String(ids.length));

  r = shop.send(p, 'cat:0', { tap: true });
  checkLimits('category page', r);
  check('vegetables paginate with More', rowIds(r).some(function (x) { return x.indexOf('pg:') === 0; }), rowIds(r).join(','));

  r = shop.send(p, 'grp:TOM', { tap: true });
  check('tomato pack picker uses buttons', r.send.kind === 'buttons' && btnIds(r).length === 3, JSON.stringify(btnIds(r)));

  r = shop.send(p, 'pk:TOM1K', { tap: true });
  check('asks quantity with tappable numbers', btnIds(r).join(',') === 'q:1,q:2,q:3', btnIds(r).join(','));

  r = shop.send(p, 'q:2', { tap: true });
  check('basket line separates items from delivery',
        /AED 13\.00 \+ AED 5\.00 delivery/.test(lastBody(r)), lastBody(r));

  // Minimum order is AED 30, so a real basket needs more than two kilos of
  // tomatoes - add rice to cross it.
  shop.send(p, 'add_more', { tap: true });
  shop.send(p, 'cat:5', { tap: true });            // Groceries
  shop.send(p, 'grp:RIC', { tap: true });
  r = shop.send(p, 'q:1', { tap: true });

  r = shop.send(p, 'checkout', { tap: true });
  check('basket shows cash on delivery', (r.send.footer || '').indexOf('Cash on delivery') >= 0, r.send.footer);
  check('basket line shows 2 x Tomatoes 1 kg at 13.00', /2 x Tomatoes 1 kg\s+-\s+AED 13\.00/.test(lastBody(r)), lastBody(r));

  r = shop.send(p, 'confirm', { tap: true });
  check('order written', shop.orders.length === 1, String(shop.orders.length));
  var o = shop.orders[0];
  check('order is COD', o.payment_mode === 'COD', o.payment_mode);
  check('order carries a map link', /maps\.google\.com/.test(o.map_link), o.map_link);
  check('order total = 13 + 32 + 5 delivery', o.total === 50, String(o.total));
  check('customer saved for next time', !!shop.customers[p].address_text, '');
})();

console.log('\n=== 2. Returning customer: repeat order with zero typing ===');
(function () {
  var shop = new Shop();
  var p = '+971500000002';
  shop.customers[p] = {
    phone: p, name: 'Fatima', wa_id: p, latitude: 25.31, longitude: 55.42,
    address_text: 'Flat 302, Marina Tower, Al Majaz', address_json: '',
    last_order_at: T0, order_count: 3, created_at: T0
  };
  var typed = 0;
  function tap(id) { var r = shop.send(p, id, { tap: true }); checkLimits('turn', r); return r; }

  var r = shop.send(p, 'hi'); typed++;          // the only non-tap in the run
  r = tap('order_now');
  check('returning customer offered saved address', btnIds(r).indexOf('addr_same') >= 0, btnIds(r).join(','));
  r = tap('addr_same');
  check('goes straight to sections', rowIds(r).some(function (x) { return x.indexOf('cat:') === 0; }), '');
  r = tap('cat:2');                              // Fruits
  r = tap('grp:BAN');
  check('single-pack item skips the pack picker', btnIds(r).join(',') === 'q:1,q:2,q:3', btnIds(r).join(','));
  r = tap('q:1');
  r = tap('add_more');
  r = tap('cat:5');                              // Groceries
  r = tap('grp:RIC');
  r = tap('q:1');
  r = tap('checkout');
  r = tap('confirm');
  check('repeat order placed in taps only', shop.orders.length === 1, String(shop.orders.length));
  check('no address was re-typed', typed === 1, String(typed));
  check('saved address reused on the order', shop.orders[0].address_text === 'Flat 302, Marina Tower, Al Majaz', shop.orders[0].address_text);
})();

console.log('\n=== 3. Handoff to staff, then resume ===');
(function () {
  var shop = new Shop();
  var p = '+971500000003';
  shop.send(p, 'hi');
  var r = shop.send(p, 'staff', { tap: true });
  check('handoff acknowledged once', /team know/i.test(lastBody(r)), lastBody(r).slice(0, 40));
  check('handoff offers a one-tap return', btnIds(r).join(',') === 'resume', btnIds(r).join(','));
  check('handoff row opened', shop.handoffs.length === 1 && shop.handoffs[0].action === 'open', '');

  r = shop.send(p, 'do you have organic carrots?');
  check('bot stays silent during handoff', r.send === null, JSON.stringify(r.send));
  check('but the message is still recorded', shop.handoffs.length === 2 && shop.handoffs[1].action === 'message', '');

  r = shop.send(p, 'resume', { tap: true });
  check('resume closes the handoff', shop.handoffs[2].action === 'close', shop.handoffs[2].action);
  check('resume restarts ordering', r.send !== null, '');
})();

console.log('\n=== 4. Typed multi-item order with local names ===');
(function () {
  var shop = new Shop({ min_order_value: '0' });
  var p = '+971500000004';
  shop.customers[p] = { phone: p, name: 'Ravi', wa_id: p, latitude: 25.31, longitude: 55.42,
    address_text: 'Villa 9, Al Qasimia', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop.send(p, 'hi');
  shop.send(p, 'order_now', { tap: true });
  shop.send(p, 'addr_same', { tap: true });

  var r = shop.send(p, '2 kg thakkali, 1 bunch kothmir');
  var body = lastBody(r);
  check('local name thakkali -> Tomatoes', /Tomatoes/.test(body), body.slice(0, 80));
  check('local name kothmir -> Coriander', /Coriander/.test(body), body.slice(0, 80));
  check('2 kg becomes 2 x 1 kg, not 8 x 250 g', /2 x Tomatoes 1 kg/.test(body), body.slice(0, 120));

  r = shop.send(p, 'confirm', { tap: true });
  check('typed order confirmed', shop.orders.length === 1, String(shop.orders.length));
  if (shop.orders.length) {
    // Tomatoes 2 kg = 7.00, Coriander bunch = 2.00, delivery 5.00
    // 2 x Tomatoes 1 kg (13.00) + 1 bunch Coriander (2.00) + 5.00 delivery
    check('typed order totals correctly', shop.orders[0].total === 20, String(shop.orders[0].total));
  }
})();

console.log('\n=== 5. Ollama is a hint, never an authority ===');
(function () {
  var shop = new Shop();
  var p = '+971500000005';
  shop.customers[p] = { phone: p, name: 'Sara', wa_id: p, latitude: 25.31, longitude: 55.42,
    address_text: 'Office 5, Industrial 17', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop.send(p, 'hi'); shop.send(p, 'order_now', { tap: true }); shop.send(p, 'addr_same', { tap: true });

  // The model hallucinates an item the customer never mentioned.
  var r = shop.send(p, 'one bunch mint please', {
    llm: { items: [{ qty: 1, name: 'mint' }, { qty: 5, name: 'imported saffron' }] }
  });
  var body = lastBody(r);
  check('grounded item is used', /Mint/.test(body), body.slice(0, 80));
  check('ungrounded hallucination is dropped', !/saffron/i.test(body), body.slice(0, 120));

  // Model down / garbage: deterministic parser must still work.
  var shop2 = new Shop();
  var p2 = '+971500000006';
  shop2.customers[p2] = { phone: p2, name: 'Sara', wa_id: p2, latitude: 25.31, longitude: 55.42,
    address_text: 'Office 5', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop2.send(p2, 'hi'); shop2.send(p2, 'order_now', { tap: true }); shop2.send(p2, 'addr_same', { tap: true });
  var r2 = shop2.send(p2, '3 x apples', { llm: null });
  check('works with no model at all', /Apples/.test(lastBody(r2)), lastBody(r2).slice(0, 80));

  // The model splits quantity and unit into separate fields
  // ({"qty":2,"amount":"kg"}), where typed text carries them together ("2 kg").
  // Both must mean two kilograms.
  var shop3 = new Shop({ min_order_value: '0' });
  var p3 = '+971500000030';
  shop3.customers[p3] = { phone: p3, name: 'Q', wa_id: p3, latitude: 25.31, longitude: 55.42,
    address_text: 'Z', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop3.send(p3, 'hi'); shop3.send(p3, 'order_now', { tap: true }); shop3.send(p3, 'addr_same', { tap: true });
  var r3 = shop3.send(p3, '2 kg thakkali and 1 bunch kothmir', {
    llm: { items: [{ qty: 2, amount: 'kg', name: 'thakkali' }, { qty: 1, amount: 'bunch', name: 'kothmir' }] }
  });
  check('model-split qty+unit means 2 kg', /2 x Tomatoes 1 kg/.test(lastBody(r3)), lastBody(r3).slice(0, 120));
  shop3.send(p3, 'confirm', { tap: true });
  // 2 x 6.50 + 2.00 + 5.00 delivery
  check('model-split order totals correctly', shop3.orders.length === 1 && shop3.orders[0].total === 20,
        shop3.orders.length ? String(shop3.orders[0].total) : 'no order');
})();

console.log('\n=== 6. Gates: range, stock, hours, minimum, duplicates ===');
(function () {
  var shop = new Shop();
  var p = '+971500000007';
  shop.send(p, 'hi'); shop.send(p, 'order_now', { tap: true });
  var r = shop.send(p, '', { lat: 24.45, lng: 54.37 });   // Abu Dhabi, ~120 km
  check('out-of-range pin refused', /only deliver within|km away/i.test(lastBody(r)), lastBody(r).slice(0, 70));
  check('out-of-range pin not stored', !shop.sessions[p].latitude, String(shop.sessions[p].latitude));
  r = shop.send(p, '', { lat: 25.31, lng: 55.42 });
  check('valid pin then accepted', /type your address/i.test(lastBody(r)), '');

  // Out of stock
  var shop2 = new Shop();
  shop2.catalog.forEach(function (row) { if (row.group_code === 'BAN') row.out_of_stock = true; });
  var p2 = '+971500000008';
  shop2.customers[p2] = { phone: p2, name: 'X', wa_id: p2, latitude: 25.31, longitude: 55.42,
    address_text: 'A', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop2.send(p2, 'hi'); shop2.send(p2, 'order_now', { tap: true }); shop2.send(p2, 'addr_same', { tap: true });
  var r2 = shop2.send(p2, 'bananas');
  check('out-of-stock item is not offered', !/1 x Bananas/.test(lastBody(r2)), lastBody(r2).slice(0, 90));

  // Closed
  var shop3 = new Shop({ open_time: '08:00', close_time: '09:00' });
  var r3 = shop3.send('+971500000009', 'hi');
  check('closed message outside hours', /closed/i.test(lastBody(r3)), lastBody(r3).slice(0, 60));

  // Paused
  var shop4 = new Shop({ accepting_orders: 'false' });
  var r4 = shop4.send('+971500000010', 'hi');
  check('paused message when not accepting', /paused/i.test(lastBody(r4)), lastBody(r4).slice(0, 60));

  // Minimum order
  var shop5 = new Shop({ min_order_value: '50' });
  var p5 = '+971500000011';
  shop5.customers[p5] = { phone: p5, name: 'Y', wa_id: p5, latitude: 25.31, longitude: 55.42,
    address_text: 'B', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop5.send(p5, 'hi'); shop5.send(p5, 'order_now', { tap: true }); shop5.send(p5, 'addr_same', { tap: true });
  shop5.send(p5, '1 bunch mint');
  var r5 = shop5.send(p5, 'confirm', { tap: true });
  check('minimum order enforced', /minimum order/i.test(lastBody(r5)), lastBody(r5).slice(0, 70));
  check('no order written below minimum', shop5.orders.length === 0, String(shop5.orders.length));

  // Duplicate webhook replay
  var shop6 = new Shop({ min_order_value: '0' });
  var p6 = '+971500000012';
  shop6.customers[p6] = { phone: p6, name: 'Z', wa_id: p6, latitude: 25.31, longitude: 55.42,
    address_text: 'C', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop6.send(p6, 'hi'); shop6.send(p6, 'order_now', { tap: true }); shop6.send(p6, 'addr_same', { tap: true });
  shop6.send(p6, 'grp:MNT', { tap: true, mid: 'wamid.A' });
  shop6.send(p6, 'q:1', { tap: true, mid: 'wamid.B' });
  shop6.send(p6, 'confirm', { tap: true, mid: 'wamid.C' });
  var dupe = shop6.send(p6, 'confirm', { tap: true, mid: 'wamid.C' });
  check('replayed message id ignored', dupe.duplicate === true, JSON.stringify(dupe.duplicate));
  check('exactly one order despite replay', shop6.orders.length === 1, String(shop6.orders.length));
})();

console.log('\n=== 7. Session expiry and free-delivery threshold ===');
(function () {
  var shop = new Shop();
  var p = '+971500000013';
  shop.customers[p] = { phone: p, name: 'W', wa_id: p, latitude: 25.31, longitude: 55.42,
    address_text: 'D', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop.send(p, 'hi'); shop.send(p, 'order_now', { tap: true }); shop.send(p, 'addr_same', { tap: true });
  shop.send(p, 'grp:MNT', { tap: true });
  shop.send(p, 'q:1', { tap: true });
  var later = new Date(new Date(T0).getTime() + 45 * 60000).toISOString();
  var r = shop.send(p, 'hi', { now: later });
  check('stale session restarts cleanly', /Welcome/i.test(lastBody(r)), lastBody(r).slice(0, 50));

  // free_delivery_over = 100: 5 kg rice (32) x 4 = 128
  var shop2 = new Shop();
  var p2 = '+971500000014';
  shop2.customers[p2] = { phone: p2, name: 'V', wa_id: p2, latitude: 25.31, longitude: 55.42,
    address_text: 'E', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop2.send(p2, 'hi'); shop2.send(p2, 'order_now', { tap: true }); shop2.send(p2, 'addr_same', { tap: true });
  shop2.send(p2, 'grp:RIC', { tap: true });
  shop2.send(p2, '4');
  var r2 = shop2.send(p2, 'checkout', { tap: true });
  check('delivery free over the threshold', /Delivery: Free/.test(lastBody(r2)), lastBody(r2));
  shop2.send(p2, 'confirm', { tap: true });
  check('free delivery reflected in total', shop2.orders[0].total === 128, String(shop2.orders[0].total));
})();

console.log('\n=== 8. Every catalogue screen respects Meta limits ===');
(function () {
  var shop = new Shop();
  var p = '+971500000015';
  shop.customers[p] = { phone: p, name: 'U', wa_id: p, latitude: 25.31, longitude: 55.42,
    address_text: 'F', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop.send(p, 'hi'); shop.send(p, 'order_now', { tap: true });
  var r = shop.send(p, 'addr_same', { tap: true });
  var bad = 0;
  for (var c = 0; c < 6; c++) {
    for (var page = 0; page < 3; page++) {
      var rr = shop.send(p, 'cat:' + c, { tap: true });
      if (page > 0) rr = shop.send(p, 'pg:' + c + ':' + page, { tap: true });
      if (checkLimits('cat ' + c + ' page ' + page, rr) === false) bad++;
      if (!rowIds(rr).some(function (x) { return x.indexOf('pg:') === 0; })) break;
    }
  }
  var cat = E.buildCatalog(shop.catalog);
  var groupsChecked = 0;
  cat.order.forEach(function (gc) {
    var rr = shop.send(p, 'grp:' + gc, { tap: true });
    if (checkLimits('group ' + gc, rr) === false) bad++;
    groupsChecked++;
  });
  check('all ' + groupsChecked + ' products render within Meta limits', bad === 0, String(bad) + ' over limit');
})();

console.log('\n=== 9. Regressions found on the deployed bot ===');
(function () {
  // A stale session read let a button TITLE be stored as the delivery address.
  var shop = new Shop();
  var p = '+971500000020';
  shop.send(p, 'hi');
  shop.send(p, 'order_now', { tap: true });
  shop.send(p, '', { lat: 25.31, lng: 55.42 });
  shop.sessions[p].current_step = 'awaiting_address';
  shop.sessions[p].pending_json = '{}';
  var r = shop.send(p, 'addr_ok', { tap: true });
  check('tap title is never stored as an address', !/Yes, correct/i.test(lastBody(r)), lastBody(r).slice(0, 80));
  check('lost address asks again instead', /type it again/i.test(lastBody(r)), lastBody(r).slice(0, 80));

  var shop2 = new Shop();
  var p2 = '+971500000021';
  shop2.customers[p2] = { phone: p2, name: 'Old', wa_id: p2, latitude: 25.31, longitude: 55.42,
    address_text: 'Villa 1', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop2.send(p2, 'hi'); shop2.send(p2, 'order_now', { tap: true }); shop2.send(p2, 'addr_same', { tap: true });
  shop2.sessions[p2].current_step = 'awaiting_name_text';
  shop2.send(p2, 'cat:0', { tap: true });
  check('tap title is never stored as a name', shop2.sessions[p2].customer_name !== 'Vegetables',
        String(shop2.sessions[p2].customer_name));

  var shop3 = new Shop();
  var p3 = '+971500000022';
  shop3.customers[p3] = { phone: p3, name: 'B', wa_id: p3, latitude: 25.31, longitude: 55.42,
    address_text: 'Villa 2', address_json: '', last_order_at: T0, order_count: 1, created_at: T0 };
  shop3.send(p3, 'hi'); shop3.send(p3, 'order_now', { tap: true }); shop3.send(p3, 'addr_same', { tap: true });
  shop3.send(p3, 'grp:MNT', { tap: true });
  shop3.send(p3, 'q:2', { tap: true });
  var r3 = shop3.send(p3, 'hi');
  check('greeting mid-basket shows the basket', /Mint/.test(lastBody(r3)), lastBody(r3).slice(0, 80));
  check('greeting mid-basket keeps the basket', JSON.parse(shop3.sessions[p3].cart_json).length === 1,
        shop3.sessions[p3].cart_json);

  var shop4 = new Shop();
  var p4 = '+971500000023';
  shop4.send(p4, 'hi');
  shop4.send(p4, 'staff', { tap: true });
  shop4.send(p4, 'resume', { tap: true });
  var closed = shop4.handoffs[shop4.handoffs.length - 1];
  check('handoff close keeps a readable message', !!closed.last_message_text, JSON.stringify(closed));
  check('handoff close keeps the customer name', closed.customer_name !== undefined, JSON.stringify(closed));
})();

console.log('\n=== 10. Browsing via Todays Prices still needs an address ===');
(function () {
  // Found on the first real WhatsApp run: tapping "Today's Prices" goes straight
  // to the catalogue, so a basket could reach Confirm with no delivery address
  // and the order was written with an empty address and no map link.
  var shop = new Shop({ min_order_value: '0' });
  var p = '+971500000040';
  shop.send(p, 'hi');
  var r = shop.send(p, 'prices', { tap: true });
  check('Todays Prices opens the catalogue', rowIds(r).some(function (x) { return x.indexOf('cat:') === 0; }), '');
  shop.send(p, 'cat:1', { tap: true });
  shop.send(p, 'grp:SPO', { tap: true });
  r = shop.send(p, 'q:2', { tap: true });
  check('item added without any address yet', /Spring Onion/.test(lastBody(r)), lastBody(r).slice(0, 60));

  r = shop.send(p, 'confirm', { tap: true });
  check('checkout refuses with nowhere to deliver', shop.orders.length === 0, String(shop.orders.length));
  check('and asks for the location instead', r.send.kind === 'location_request', r.send.kind);
  check('basket survives the detour', JSON.parse(shop.sessions[p].cart_json).length === 1,
        shop.sessions[p].cart_json);

  shop.send(p, '', { lat: 25.31, lng: 55.42 });
  shop.send(p, 'Shop 4, Al Qasimia, near the clock tower');
  shop.send(p, 'addr_ok', { tap: true });
  r = shop.send(p, 'name_ok', { tap: true });
  check('returns to the basket, not the section list', /Spring Onion/.test(lastBody(r)), lastBody(r).slice(0, 70));

  r = shop.send(p, 'confirm', { tap: true });
  check('now the order goes through', shop.orders.length === 1, String(shop.orders.length));
  if (shop.orders.length) {
    check('order carries the address', !!shop.orders[0].address_text, shop.orders[0].address_text);
    check('order carries a map link', /maps\.google\.com/.test(shop.orders[0].map_link), shop.orders[0].map_link);
  }
})();


console.log('\n=== 11. Reaching a person, and messages the bot cannot read ===');
(function () {
  var shop = new Shop();
  var p = '+971500000911';

  var r = shop.send(p, 'hi');
  check('greeting names the escape hatch', /talk to staff/i.test(lastBody(r)), lastBody(r).slice(0, 80));
  check('greeting button says Self Order Now',
        ((r.send.buttons || [])[0] || {}).title === 'Self Order Now',
        ((r.send.buttons || [])[0] || {}).title);
  check('greeting button says Chat with us',
        ((r.send.buttons || [])[1] || {}).title === 'Chat with us',
        ((r.send.buttons || [])[1] || {}).title);

  // Mid-order, typed in the middle of browsing.
  r = shop.send(p, 'order_now', { tap: true });
  r = shop.send(p, '', { lat: 25.31, lng: 55.42 });
  r = shop.send(p, 'Villa 12, Al Nahda');
  r = shop.send(p, 'name_profile', { tap: true });
  r = shop.send(p, 'talk to staff');
  check('typed "talk to staff" hands over', !!r.handoff && r.handoff.action === 'open',
        r.handoff && r.handoff.action);
  check('and the shop is told who it is', (r.handoff || {}).customer_phone === p,
        (r.handoff || {}).customer_phone);
  check('handover is the logged event', r.event.action === 'handoff_start', r.event.action);

  // Already with a person: no second handoff, no second notification.
  r = shop.send(p, 'talk to staff');
  check('asking twice does not re-open', (r.handoff || {}).action === 'message',
        (r.handoff || {}).action);
  check('and the bot stays quiet', r.send === null, String(r.send));
})();

(function () {
  var shop = new Shop();
  var p = '+971500000912';
  shop.send(p, 'hi');

  var r = shop.send(p, '', { type: 'audio' });
  check('a voice note is nudged, not ignored', /cannot open voice notes/i.test(lastBody(r)),
        lastBody(r).slice(0, 60));
  check('the nudge offers the same two buttons', btnIds(r).join(',') === 'order_now,staff',
        btnIds(r).join(','));
  check('nudging does not open a handoff', r.handoff === null, String(r.handoff));
  check('the nudge is logged', r.event.action === 'media_nudge', r.event.action);

  r = shop.send(p, '', { type: 'image' });
  check('a second one hands over', (r.handoff || {}).action === 'open', (r.handoff || {}).action);
  check('and says what was sent', /image/.test((r.handoff || {}).last_message_text || ''),
        (r.handoff || {}).last_message_text);

  // Once with a person, media just passes through silently.
  r = shop.send(p, '', { type: 'document' });
  check('later media reaches staff quietly', (r.handoff || {}).action === 'message',
        (r.handoff || {}).action);
  check('bot does not talk over the human', r.send === null, String(r.send));
})();

(function () {
  var shop = new Shop();
  var p = '+971500000913';
  shop.send(p, 'hi');
  shop.send(p, '', { type: 'audio' });
  // A normal message in between means the next photo starts from one warning.
  shop.send(p, 'order_now', { tap: true });
  var r = shop.send(p, '', { type: 'audio' });
  check('a normal reply resets the one-warning rule',
        r.handoff === null && /cannot open voice notes/i.test(lastBody(r)),
        String(r.handoff) + ' | ' + lastBody(r).slice(0, 40));
})();

console.log('\n--------------------------------------------------');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:'); failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
