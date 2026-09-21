/* DailyFresh conversation engine - deterministic, tap-first.
 *
 * Pure function: runEngine(input) -> output. No network, no clock, no randomness
 * beyond what is passed in, so it can be unit-tested locally and dropped into an
 * n8n Code node unchanged.
 *
 * It NEVER asks a model anything. Ollama output arrives pre-computed on
 * input.llm and is treated as an untrusted hint: every item name it returns must
 * already appear in the customer's own message or it is discarded.
 */

// ---------------------------------------------------------------- limits
// Meta Cloud API interactive message ceilings. Exceeding any of these makes the
// send fail with a 400, so every string is cut to fit before it goes out.
var MAX_BUTTONS = 3;
var MAX_ROWS = 10;
var LEN = { body: 1024, btn: 20, rowTitle: 24, rowDesc: 72, secTitle: 24, listBtn: 20, header: 60, footer: 60 };

function cut(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1).trim() + '\u2026';
}

// ---------------------------------------------------------------- text utils
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function digits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
function titleOf(p) { return p.item_name + ' ' + p.pack_label; }

function levenshtein(a, b, cap) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur[0] = i;
    var best = cur[0];
    for (j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur.slice();
  }
  return prev[b.length];
}

// ---------------------------------------------------------------- geo
function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------- time
function localParts(nowIso, offsetMin) {
  var t = new Date(new Date(nowIso).getTime() + offsetMin * 60000);
  return {
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()],
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
    stamp: t.toISOString().slice(0, 19).replace(/[-:T]/g, ''),
    date: t.toISOString().slice(0, 10)
  };
}
function hhmmToMin(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
}

// ---------------------------------------------------------------- catalogue
// One catalogue row == one sellable pack, so every row already carries its own
// price. group_code is what collapses the packs of a product into a single
// browsing entry with a pack picker.
function buildCatalog(rows) {
  var packs = [], i, r;
  for (i = 0; i < (rows || []).length; i++) {
    r = rows[i] || {};
    var price = Number(r.price);
    if (!r.item_code || !r.item_name || !isFinite(price) || price <= 0) continue;
    if (r.listed === false || String(r.listed).toLowerCase() === 'false') continue;
    packs.push({
      item_code: String(r.item_code).trim(),
      group_code: String(r.group_code || r.item_code).trim(),
      item_name: String(r.item_name).trim(),
      pack_label: String(r.pack_label || '').trim(),
      unit: String(r.unit || '').trim(),
      category: String(r.category || 'Other').trim(),
      price: price,
      out_of_stock: (r.out_of_stock === true || String(r.out_of_stock).toLowerCase() === 'true'),
      aliases: String(r.aliases || ''),
      search_text: String(r.search_text || ''),
      sort_order: Number(r.sort_order) || 0
    });
  }
  packs.sort(function (a, b) { return a.sort_order - b.sort_order; });

  var groups = {}, order = [];
  for (i = 0; i < packs.length; i++) {
    var p = packs[i];
    if (!groups[p.group_code]) {
      groups[p.group_code] = {
        group_code: p.group_code, item_name: p.item_name, category: p.category,
        unit: p.unit, aliases: p.aliases, sort_order: p.sort_order, packs: []
      };
      order.push(p.group_code);
    }
    groups[p.group_code].packs.push(p);
  }

  var categories = [], seen = {};
  for (i = 0; i < order.length; i++) {
    var g = groups[order[i]];
    // A product is browsable only while at least one of its packs is in stock.
    g.inStock = g.packs.filter(function (x) { return !x.out_of_stock; });
    if (!seen[g.category]) { seen[g.category] = true; categories.push(g.category); }
  }
  return { packs: packs, groups: groups, order: order, categories: categories };
}

function groupsInCategory(cat, catalog) {
  var out = [];
  for (var i = 0; i < catalog.order.length; i++) {
    var g = catalog.groups[catalog.order[i]];
    if (g.category === cat && g.inStock.length) out.push(g);
  }
  return out;
}

function priceFrom(g) {
  var min = null;
  for (var i = 0; i < g.inStock.length; i++) {
    if (min === null || g.inStock[i].price < min) min = g.inStock[i].price;
  }
  return min;
}

// ---------------------------------------------------------------- matching
// Deterministic, ordered, and entirely independent of the model:
// exact code -> exact name -> alias -> substring -> bounded fuzzy.
function scoreGroup(g, q) {
  var name = norm(g.item_name);
  var aliases = norm(g.aliases);
  var hay = norm(g.item_name + ' ' + g.aliases + ' ' + g.category);
  if (!q) return 0;
  if (name === q) return 100;
  if ((' ' + aliases + ' ').indexOf(' ' + q + ' ') >= 0) return 90;
  // Substring matching on one or two letters is worse than useless: "hi" is
  // inside "white bread" and "bhindi", so a greeting would look like an order.
  // Below three characters only an exact name or alias counts.
  if (q.length < 3) return 0;
  if (name.indexOf(q) === 0) return 80;
  if (name.indexOf(q) >= 0) return 70;
  if (aliases.indexOf(q) >= 0) return 60;

  var toks = q.split(' '), hit = 0, t;
  for (var i = 0; i < toks.length; i++) {
    t = toks[i];
    if (t.length >= 3 && hay.indexOf(t) >= 0) hit++;
  }
  if (hit) return 40 + hit;

  // Fuzzy is last and deliberately tight: one edit for short words, two for long.
  var words = name.split(' ');
  for (var w = 0; w < words.length; w++) {
    for (var k = 0; k < toks.length; k++) {
      if (toks[k].length < 4) continue;
      var cap = toks[k].length > 6 ? 2 : 1;
      if (levenshtein(toks[k], words[w], cap) <= cap) return 30;
    }
  }
  return 0;
}

function searchGroups(text, catalog, limit) {
  var q = norm(text);
  if (!q) return [];
  // An exact item_code wins outright - it is unambiguous.
  for (var i = 0; i < catalog.packs.length; i++) {
    if (catalog.packs[i].item_code.toLowerCase() === String(text).trim().toLowerCase()) {
      var gg = catalog.groups[catalog.packs[i].group_code];
      if (gg && gg.inStock.length) return [gg];
    }
  }
  var scored = [];
  for (var j = 0; j < catalog.order.length; j++) {
    var g = catalog.groups[catalog.order[j]];
    if (!g.inStock.length) continue;
    var s = scoreGroup(g, q);
    if (s > 0) scored.push({ g: g, s: s });
  }
  scored.sort(function (a, b) { return b.s - a.s || a.g.sort_order - b.g.sort_order; });
  return scored.slice(0, limit || 8).map(function (x) { return x.g; });
}

// ---------------------------------------------------------------- quantities
// "2 kg tomatoes" means two kilograms, not two packets - so a typed amount is
// canonicalised and matched against the real pack sizes before it becomes a
// quantity. Anything that cannot be satisfied exactly falls through to the pack
// picker rather than guessing.
var UNIT_MAP = {
  kg: ['g', 1000], kilo: ['g', 1000], kilos: ['g', 1000], kilogram: ['g', 1000], kilograms: ['g', 1000], kgs: ['g', 1000],
  g: ['g', 1], gm: ['g', 1], gms: ['g', 1], gram: ['g', 1], grams: ['g', 1],
  l: ['ml', 1000], ltr: ['ml', 1000], litre: ['ml', 1000], liter: ['ml', 1000], litres: ['ml', 1000], liters: ['ml', 1000],
  ml: ['ml', 1],
  pc: ['pcs', 1], pcs: ['pcs', 1], piece: ['pcs', 1], pieces: ['pcs', 1], nos: ['pcs', 1],
  dozen: ['pcs', 12],
  box: ['box', 1], boxes: ['box', 1],
  bunch: ['bunch', 1], bunches: ['bunch', 1],
  head: ['head', 1], heads: ['head', 1],
  pack: ['pack', 1], packet: ['pack', 1], packs: ['pack', 1],
  loaf: ['loaf', 1], loaves: ['loaf', 1],
  tray: ['tray', 1], trays: ['tray', 1],
  whole: ['whole', 1]
};
var WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
var FRACTION = { half: 0.5, quarter: 0.25 };

function canonAmount(text) {
  var t = norm(text);
  if (!t) return null;
  var m = /(\d+(?:\.\d+)?)\s*([a-z]+)/.exec(t);
  var n = null, unitWord = null;
  if (m) { n = parseFloat(m[1]); unitWord = m[2]; }
  else {
    var f = /\b(half|quarter)\s*(?:a\s*)?([a-z]+)/.exec(t);
    if (f) { n = FRACTION[f[1]]; unitWord = f[2]; }
    else {
      var w = /\b([a-z]+)\s+([a-z]+)\b/.exec(t);
      if (w && WORD_NUM[w[1]] && UNIT_MAP[w[2]]) { n = WORD_NUM[w[1]]; unitWord = w[2]; }
      else {
        var u = /\b([a-z]+)\b/.exec(t);
        if (u && UNIT_MAP[u[1]]) { n = 1; unitWord = u[1]; }
      }
    }
  }
  if (n === null || !unitWord || !UNIT_MAP[unitWord]) return null;
  var map = UNIT_MAP[unitWord];
  return { n: n * map[1], u: map[0] };
}

// Turn a requested amount into (pack, qty) against this product's real packs.
// Prefers one exact pack, then the LARGEST pack that divides the amount evenly -
// "2 kg" should come back as 2 x 1 kg, never as 8 x 250 g.
function scaleAmount(want, qty) {
  if (!want) return null;
  var n = (qty === null || qty === undefined) ? 1 : Number(qty);
  if (!isFinite(n) || n < 1) n = 1;
  return { n: want.n * n, u: want.u };
}

function packForAmount(group, want) {
  if (!want) return null;
  var cands = [], i, a;
  for (i = 0; i < group.inStock.length; i++) {
    a = canonAmount(group.inStock[i].pack_label);
    if (a && a.u === want.u && a.n > 0) cands.push({ pack: group.inStock[i], n: a.n });
  }
  if (!cands.length) return null;

  for (i = 0; i < cands.length; i++) {
    if (Math.abs(cands[i].n - want.n) < 1e-6) return { pack: cands[i].pack, qty: 1 };
  }
  cands.sort(function (x, y) { return y.n - x.n; });
  for (i = 0; i < cands.length; i++) {
    var mult = want.n / cands[i].n;
    // Only a clean whole multiple - 1.5 x a 1 kg pack is not a thing.
    if (mult >= 1 && Math.abs(mult - Math.round(mult)) < 1e-6) {
      return { pack: cands[i].pack, qty: Math.round(mult) };
    }
  }
  return null;
}

// Split a typed message into {qty, amountText, name} lines, deterministically.
function parseOrderLines(text) {
  var raw = String(text || '');
  var chunks = raw.split(/\s*(?:,|;|\n|\band\b|\bplus\b|\+)\s*/i);
  var out = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = String(chunks[i] || '').trim();
    if (!c) continue;
    var qty = null, rest = c;

    var lead = /^(\d+)\s*(?:x|\*)\s*(.+)$/i.exec(c);
    if (lead) { qty = parseInt(lead[1], 10); rest = lead[2]; }

    var amountText = null;
    var amt = /(\d+(?:\.\d+)?\s*(?:kgs?|kilos?|kilograms?|g|gm|gms|grams?|ltrs?|litres?|liters?|l|ml|pcs?|pieces?|dozen|boxes?|bunch(?:es)?|heads?|packe?t?s?|loaves|loaf|trays?))\b/i.exec(rest);
    if (!amt) amt = /\b((?:half|quarter)\s*(?:a\s*)?(?:kgs?|kilos?|kilograms?|ltrs?|litres?|liters?|l|boxes?|bunch(?:es)?|packe?t?s?))\b/i.exec(rest);
    if (amt) { amountText = amt[1]; rest = rest.replace(amt[0], ' '); }

    if (qty === null) {
      var lq = /^(\d+)\s+(.+)$/.exec(rest.trim());
      if (lq) { qty = parseInt(lq[1], 10); rest = lq[2]; }
    }
    if (qty === null) {
      var wq = /^([a-z]+)\s+(.+)$/i.exec(rest.trim());
      if (wq && WORD_NUM[wq[1].toLowerCase()] !== undefined) { qty = WORD_NUM[wq[1].toLowerCase()]; rest = wq[2]; }
    }

    var name = rest.replace(/\b(of|the|some|please|pls|kindly)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!name && !amountText) continue;
    out.push({ qty: qty, amountText: amountText, name: name, raw: c });
  }
  return out;
}

// ---------------------------------------------------------------- model hints
// The model only ever splits and tidies. Its item names must be grounded in what
// the customer actually typed, or they are thrown away - this is what stops it
// inventing products or prices.
function groundedLines(llm, rawText) {
  if (!llm || !llm.items || !llm.items.length) return null;
  var hay = norm(rawText), out = [];
  for (var i = 0; i < llm.items.length; i++) {
    var it = llm.items[i] || {};
    var nm = String(it.name == null ? '' : it.name).trim();
    if (!nm) continue;
    var toks = norm(nm).split(' ').filter(function (t) { return t.length > 1; });
    if (!toks.length) continue;
    var ok = true;
    for (var t = 0; t < toks.length; t++) {
      if (hay.indexOf(toks[t]) < 0) { ok = false; break; }
    }
    if (!ok) continue;            // ungrounded - discard the whole line
    var q = parseInt(it.qty, 10);
    out.push({ qty: (isFinite(q) && q > 0) ? q : null, amountText: it.amount || null, name: nm, raw: nm });
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------- outbound
// Every builder clamps to Meta's ceilings, so a long product name or a big cart
// can never produce a 400 from the send call.
function mText(body) { return { kind: 'text', body: cut(body, LEN.body) }; }

function mButtons(body, buttons, header, footer) {
  return {
    kind: 'buttons',
    body: cut(body, LEN.body),
    header: header ? cut(header, LEN.header) : null,
    footer: footer ? cut(footer, LEN.footer) : null,
    buttons: (buttons || []).slice(0, MAX_BUTTONS).map(function (b) {
      return { id: String(b.id).slice(0, 256), title: cut(b.title, LEN.btn) };
    })
  };
}

function mList(body, buttonText, sections, header, footer) {
  var used = 0, out = [];
  for (var i = 0; i < (sections || []).length; i++) {
    var s = sections[i], rows = [];
    for (var j = 0; j < (s.rows || []).length; j++) {
      if (used >= MAX_ROWS) break;
      var r = s.rows[j];
      rows.push({
        id: String(r.id).slice(0, 200),
        title: cut(r.title, LEN.rowTitle),
        description: r.description ? cut(r.description, LEN.rowDesc) : ''
      });
      used++;
    }
    if (rows.length) out.push({ title: cut(s.title || ' ', LEN.secTitle), rows: rows });
    if (used >= MAX_ROWS) break;
  }
  return {
    kind: 'list',
    body: cut(body, LEN.body),
    header: header ? cut(header, LEN.header) : null,
    footer: footer ? cut(footer, LEN.footer) : null,
    button: cut(buttonText || 'Choose', LEN.listBtn),
    sections: out
  };
}

function mLocation(body) { return { kind: 'location_request', body: cut(body, LEN.body) }; }

// ---------------------------------------------------------------- cart
function cartAdd(cart, pack, qty) {
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].item_code === pack.item_code) {
      cart[i].qty += qty;
      cart[i].line_total = round2(cart[i].qty * cart[i].unit_price);
      return cart[i];
    }
  }
  var line = {
    item_code: pack.item_code, group_code: pack.group_code,
    item_name: pack.item_name, pack_label: pack.pack_label,
    qty: qty, unit_price: pack.price, line_total: round2(qty * pack.price)
  };
  cart.push(line);
  return line;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function cartTotals(cart, cfg) {
  var sub = 0;
  for (var i = 0; i < cart.length; i++) sub += Number(cart[i].line_total) || 0;
  sub = round2(sub);
  var fee = Number(cfg.delivery_fee) || 0;
  var freeOver = Number(cfg.free_delivery_over) || 0;
  if (freeOver > 0 && sub >= freeOver) fee = 0;
  return { subtotal: sub, delivery_fee: round2(fee), total: round2(sub + fee), count: cart.length };
}

function money(cfg, n) { return (cfg.currency || 'AED') + ' ' + (round2(n)).toFixed(2); }

function cartText(cart, cfg) {
  if (!cart.length) return 'Your basket is empty.';
  var t = cartTotals(cart, cfg), lines = [];
  for (var i = 0; i < cart.length; i++) {
    var c = cart[i];
    lines.push(c.qty + ' x ' + c.item_name + ' ' + c.pack_label + '  -  ' + money(cfg, c.line_total));
  }
  var out = lines.join('\n') + '\n\nSubtotal: ' + money(cfg, t.subtotal);
  out += '\nDelivery: ' + (t.delivery_fee > 0 ? money(cfg, t.delivery_fee) : 'Free');
  out += '\nTotal: ' + money(cfg, t.total);
  return out;
}

// ---------------------------------------------------------------- config
function parseConfig(rows) {
  var cfg = {}, i;
  if (Array.isArray(rows)) {
    for (i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      if (r.config_key) cfg[String(r.config_key)] = r.value;
    }
  } else if (rows && typeof rows === 'object') {
    cfg = JSON.parse(JSON.stringify(rows));
  }
  function num(k, d) { var v = parseFloat(cfg[k]); return isFinite(v) ? v : d; }
  function bool(k, d) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') return d;
    return !(cfg[k] === false || String(cfg[k]).toLowerCase() === 'false' || String(cfg[k]) === '0');
  }
  return {
    business_name: cfg.business_name || 'Our shop',
    currency: cfg.currency || 'AED',
    order_prefix: cfg.order_prefix || 'BQ',
    open_days: String(cfg.open_days || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun'),
    open_time: cfg.open_time || '', close_time: cfg.close_time || '',
    timezone_offset_min: num('timezone_offset_min', 240),
    shop_lat: num('shop_lat', NaN), shop_lng: num('shop_lng', NaN),
    delivery_radius_km: num('delivery_radius_km', 0),
    delivery_fee: num('delivery_fee', 0),
    free_delivery_over: num('free_delivery_over', 0),
    min_order_value: num('min_order_value', 0),
    max_qty: num('max_qty', 50),
    session_ttl_minutes: num('session_ttl_minutes', 30),
    accepting_orders: bool('accepting_orders', true),
    support_phone: cfg.support_phone || '',
    delivery_eta: cfg.delivery_eta || 'soon',
    closed_message: cfg.closed_message || '',
    paused_message: cfg.paused_message || '',
    too_far_message: cfg.too_far_message || '',
    llm_enabled: bool('llm_enabled', true)
  };
}

function isOpen(cfg, nowIso) {
  var lp = localParts(nowIso, cfg.timezone_offset_min);
  var days = cfg.open_days.split(',').map(function (d) { return d.trim().slice(0, 3).toLowerCase(); });
  if (days.length && days[0] !== '' && days.indexOf(lp.dow.toLowerCase()) < 0) return false;
  var o = hhmmToMin(cfg.open_time), c = hhmmToMin(cfg.close_time);
  if (o === null || c === null) return true;
  if (o === c) return true;
  return (c > o) ? (lp.minutes >= o && lp.minutes < c)
                 : (lp.minutes >= o || lp.minutes < c);   // overnight close
}

// ---------------------------------------------------------------- screens
function screenGreeting(cfg, open) {
  if (!open) {
    var msg = (cfg.closed_message || 'We are closed at the moment.')
      .replace('{open_time}', cfg.open_time || '').replace('{close_time}', cfg.close_time || '');
    return mButtons(msg, [{ id: 'staff', title: 'Talk to Staff' }], cfg.business_name);
  }
  if (!cfg.accepting_orders) {
    return mButtons(cfg.paused_message || 'We have paused new orders for a short while.',
      [{ id: 'staff', title: 'Talk to Staff' }], cfg.business_name);
  }
  return mButtons(
    'Welcome to ' + cfg.business_name + '! Fresh fruit, vegetables and groceries delivered to your door.\n\nTap Order Now to start, or Talk to Staff if you would rather chat with us.',
    [{ id: 'order_now', title: 'Order Now' },
     { id: 'prices', title: 'Today’s Prices' },
     { id: 'staff', title: 'Talk to Staff' }],
    cfg.business_name);
}

function screenCategories(catalog, cfg, nowIso, note) {
  var lp = localParts(nowIso, cfg.timezone_offset_min);
  var rows = [];
  for (var i = 0; i < catalog.categories.length; i++) {
    var cat = catalog.categories[i];
    var n = groupsInCategory(cat, catalog).length;
    if (!n) continue;
    rows.push({ id: 'cat:' + i, title: cat, description: n + ' item' + (n === 1 ? '' : 's') });
  }
  var extra = [{ id: 'srch', title: 'Search by name', description: 'Type what you are looking for' }];
  return mList(
    (note ? note + '\n\n' : '') + 'Prices for ' + lp.date + '. Pick a section to browse.',
    'Browse', [{ title: 'Sections', rows: rows }, { title: 'Other', rows: extra }],
    cfg.business_name);
}

function screenCategory(catalog, catIdx, page, cfg) {
  var cat = catalog.categories[catIdx];
  var all = groupsInCategory(cat, catalog);
  var per = 8, start = page * per, slice = all.slice(start, start + per);
  var rows = slice.map(function (g) {
    var labels = g.inStock.map(function (p) { return p.pack_label; }).join(' / ');
    return {
      id: 'grp:' + g.group_code,
      title: g.item_name,
      description: 'From ' + money(cfg, priceFrom(g)) + ' · ' + labels
    };
  });
  var nav = [];
  if (start + per < all.length) {
    nav.push({ id: 'pg:' + catIdx + ':' + (page + 1), title: 'More items',
               description: (all.length - start - per) + ' more in ' + cat });
  }
  nav.push({ id: 'cats', title: 'All sections', description: 'Back to the section list' });
  return mList(cat + ' - tap an item to see pack sizes and prices.', 'Choose item',
    [{ title: cat, rows: rows }, { title: 'Navigate', rows: nav }], cfg.business_name);
}

function screenPacks(group, cfg) {
  var packs = group.inStock;
  var body = group.item_name + ' - choose a pack size.';
  if (packs.length <= MAX_BUTTONS) {
    return mButtons(body, packs.map(function (p) {
      return { id: 'pk:' + p.item_code, title: p.pack_label + ' ' + money(cfg, p.price) };
    }), group.item_name);
  }
  var rows = packs.map(function (p) {
    return { id: 'pk:' + p.item_code, title: p.pack_label, description: money(cfg, p.price) };
  });
  rows.push({ id: 'cats', title: 'All sections', description: 'Back to the section list' });
  return mList(body, 'Pack size', [{ title: group.item_name, rows: rows }], group.item_name);
}

function screenQty(pack, cfg) {
  return mButtons(
    'How many ' + pack.item_name + ' ' + pack.pack_label + '?  (' + money(cfg, pack.price) + ' each)\n\nTap a number, or send any number.',
    [{ id: 'q:1', title: '1' }, { id: 'q:2', title: '2' }, { id: 'q:3', title: '3' }],
    pack.item_name);
}

function screenAdded(cart, cfg, addedText) {
  var t = cartTotals(cart, cfg);
  return mButtons(addedText + '\n\nBasket: ' + t.count + ' item' + (t.count === 1 ? '' : 's') +
    ', ' + money(cfg, t.subtotal) +
    (t.delivery_fee > 0 ? ' + ' + money(cfg, t.delivery_fee) + ' delivery' : ' + free delivery') + '.',
    [{ id: 'add_more', title: 'Add more' },
     { id: 'cart', title: 'View basket' },
     { id: 'checkout', title: 'Checkout' }]);
}

function screenCart(cart, cfg) {
  return mButtons(cartText(cart, cfg),
    [{ id: 'confirm', title: 'Confirm order' },
     { id: 'add_more', title: 'Add more' },
     { id: 'edit', title: 'Edit basket' }],
    'Your basket', 'Cash on delivery');
}

function screenEdit(cart, cfg) {
  var rows = cart.map(function (c) {
    return { id: 'rm:' + c.item_code, title: 'Remove ' + c.item_name,
             description: c.qty + ' x ' + c.pack_label + ' · ' + money(cfg, c.line_total) };
  });
  var nav = [{ id: 'cart', title: 'Back to basket', description: 'Keep everything' },
             { id: 'cancel', title: 'Cancel order', description: 'Empty the basket and stop' }];
  return mList('Tap an item to remove it.', 'Edit',
    [{ title: 'In your basket', rows: rows }, { title: 'Other', rows: nav }], 'Edit basket');
}

function screenSearchResults(groups, cfg, term) {
  var rows = groups.map(function (g) {
    var labels = g.inStock.map(function (p) { return p.pack_label; }).join(' / ');
    return { id: 'grp:' + g.group_code, title: g.item_name,
             description: 'From ' + money(cfg, priceFrom(g)) + ' · ' + labels };
  });
  rows.push({ id: 'cats', title: 'All sections', description: 'Browse everything instead' });
  return mList('Results for ' + cut(term, 40) + ' - tap one.', 'Choose item',
    [{ title: 'Matches', rows: rows }], null);
}

// ---------------------------------------------------------------- engine
// Openers that must always be read as "hello", never as a product search.
var GREETINGS = ['HI', 'HII', 'HIII', 'HEY', 'HELLO', 'HELO', 'HALLO', 'YO', 'START',
  'SALAM', 'SALAAM', 'ASSALAMUALAIKUM', 'AS SALAM ALAIKUM', 'MARHABA', 'AHLAN',
  'GOOD MORNING', 'GOOD EVENING', 'GOOD AFTERNOON', 'NAMASTE', 'VANAKKAM', 'HI THERE'];

var NUDGE = 'Almost there - I just need somewhere to deliver.' + String.fromCharCode(10,10);

var HELP_TEXT = 'Here is what I can do:\n\n' +
  '• Tap Order Now and I will walk you through it\n' +
  '• Or just type what you want, like "2 kg tomatoes, 1 bunch coriander"\n' +
  '• CART shows your basket, CANCEL clears it\n' +
  '• STAFF puts you through to a person\n\n' +
  'Payment is cash on delivery.';

function runEngine(input) {
  var nowIso = input.now || new Date().toISOString();
  var now = new Date(nowIso);
  var inb = input.inbound || {};
  var cfg = parseConfig(input.config);
  var catalog = buildCatalog(input.catalog);
  var cust = input.customer || null;
  var open = isOpen(cfg, nowIso);
  var lp = localParts(nowIso, cfg.timezone_offset_min);

  var tap = String(inb.reply_id == null ? '' : inb.reply_id).trim();
  var text = String(inb.text == null ? '' : inb.text).trim();
  // A button or list reply carries a TITLE as well as an id. That title is a
  // label we wrote, not something the customer typed, so it must never be
  // consumed as an address, a name, a quantity or a search term - otherwise a
  // tap arriving against unexpected state gets stored as "Yes, correct".
  var typed = tap ? '' : text;
  var upper = typed.toUpperCase().replace(/\s+/g, ' ').trim();
  var hasLoc = (inb.latitude !== undefined && inb.latitude !== null && inb.latitude !== '' &&
                inb.longitude !== undefined && inb.longitude !== null && inb.longitude !== '');

  function fresh() {
    return {
      phone: inb.phone || '', wa_id: inb.wa_id || '', profile_name: inb.profile_name || '',
      customer_name: '', current_step: 'start', cart_json: '[]', pending_json: '{}',
      nav_json: '{}', latitude: '', longitude: '', address_text: '',
      last_message_id: '', last_bot_message: '',
      expires_at: new Date(now.getTime() + cfg.session_ttl_minutes * 60000).toISOString(),
      updated_at: nowIso
    };
  }

  var prev = input.session || null;
  var expired = false;
  if (prev && prev.expires_at) {
    var ex = new Date(prev.expires_at);
    if (!isNaN(ex.getTime()) && now > ex) expired = true;
  }
  var isNew = (!prev || expired);

  var S = fresh();
  if (!isNew) {
    for (var k in prev) { if (Object.prototype.hasOwnProperty.call(prev, k) && S[k] !== undefined) S[k] = prev[k]; }
    S.expires_at = new Date(now.getTime() + cfg.session_ttl_minutes * 60000).toISOString();
    S.updated_at = nowIso;
  }
  S.phone = inb.phone || S.phone;
  if (inb.profile_name) S.profile_name = inb.profile_name;

  // Meta replays webhooks; a repeated message id must never re-add to a basket
  // or place a second order.
  if (!isNew && inb.message_id && String(S.last_message_id) === String(inb.message_id)) {
    return { duplicate: true, send: null, session: S, customer: null, order: null, handoff: null,
             event: { action: 'duplicate_ignored', level: 'debug', detail: String(inb.message_id), ref_id: '' } };
  }
  S.last_message_id = inb.message_id || '';

  function jparse(s, d) { try { var v = JSON.parse(s || ''); return v == null ? d : v; } catch (e) { return d; } }
  var cart = jparse(S.cart_json, []); if (!Array.isArray(cart)) cart = [];
  var pending = jparse(S.pending_json, {}) || {};
  var nav = jparse(S.nav_json, {}) || {};

  var out = {
    duplicate: false, send: null, session: S, customer: null, order: null, handoff: null,
    event: { action: 'noop', level: 'info', detail: '', ref_id: '' }
  };
  function ev(action, detail, level) {
    out.event = { action: action, level: level || 'info', detail: String(detail == null ? '' : detail), ref_id: '' };
  }

  // ------------------------------------------------------------ small actions
  function touchCustomer(extra) {
    var base = {
      phone: S.phone, name: S.customer_name || S.profile_name || '', wa_id: S.wa_id || '',
      latitude: S.latitude === '' ? null : Number(S.latitude),
      longitude: S.longitude === '' ? null : Number(S.longitude),
      address_text: S.address_text || '', address_json: pending.addr ? JSON.stringify(pending.addr) : ((cust && cust.address_json) || ''),
      last_order_at: (cust && cust.last_order_at) || null,
      order_count: Number((cust && cust.order_count) || 0),
      created_at: (cust && cust.created_at) || nowIso
    };
    for (var key in (extra || {})) base[key] = extra[key];
    out.customer = base;
  }

  function startHandoff() {
    S.current_step = 'human_handoff';
    out.send = mButtons(
      'No problem - I have let the ' + cfg.business_name + ' team know and someone will reply here shortly.' +
      (cfg.support_phone ? '\n\nIn a hurry? Call us on ' + cfg.support_phone + '.' : '') +
      '\n\nTap below any time to go back to ordering.',
      [{ id: 'resume', title: 'Back to ordering' }]);
    out.handoff = {
      action: 'open', customer_phone: S.phone,
      customer_name: S.customer_name || S.profile_name || '',
      last_message_text: typed || '(tapped Talk to Staff)', opened_at: nowIso, last_message_at: nowIso, status: 'open'
    };
    ev('handoff_start', typed || 'tap');
  }

  function handoffQuiet() {
    // The bot stays silent so it never talks over a human.
    out.send = null;
    out.handoff = { action: 'message', customer_phone: S.phone,
      customer_name: S.customer_name || S.profile_name || '',
      last_message_text: typed || '(media)', last_message_at: nowIso, status: 'open' };
    ev('handoff_message', typed);
  }

  function showCategories(note) {
    S.current_step = 'browsing';
    nav = {};
    out.send = screenCategories(catalog, cfg, nowIso, note);
    ev('categories_sent', '');
  }

  function showCategory(idx, page) {
    if (idx < 0 || idx >= catalog.categories.length) { showCategories(); return; }
    S.current_step = 'category';
    nav = { c: idx, p: page };
    out.send = screenCategory(catalog, idx, page, cfg);
    ev('category_sent', catalog.categories[idx] + ' p' + page);
  }

  function showGroup(groupCode) {
    var g = catalog.groups[groupCode];
    if (!g || !g.inStock.length) { showCategories('Sorry, that item just went out of stock.'); return; }
    if (g.inStock.length === 1) { askQty(g.inStock[0]); return; }   // one pack, one less tap
    S.current_step = 'awaiting_pack';
    pending = { group: groupCode };
    out.send = screenPacks(g, cfg);
    ev('packs_sent', groupCode);
  }

  function askQty(pack) {
    S.current_step = 'awaiting_qty';
    pending = { item_code: pack.item_code };
    out.send = screenQty(pack, cfg);
    ev('qty_asked', pack.item_code);
  }

  function packByCode(code) {
    for (var i = 0; i < catalog.packs.length; i++) {
      if (catalog.packs[i].item_code === code) return catalog.packs[i];
    }
    return null;
  }

  function addPack(pack, qty) {
    if (pack.out_of_stock) { showCategories(pack.item_name + ' is out of stock today.'); return; }
    var q = Math.max(1, Math.min(Math.round(qty) || 1, cfg.max_qty));
    cartAdd(cart, pack, q);
    pending = {};
    S.current_step = 'cart_review';
    out.send = screenAdded(cart, cfg, 'Added ' + q + ' x ' + pack.item_name + ' ' + pack.pack_label + '.');
    ev('item_added', pack.item_code + ' x' + q);
  }

  function afterAddress(note) {
    if (cart.length) { showCart(); return; }
    showCategories(note);
  }

  function showCart() {
    S.current_step = 'cart_review';
    out.send = cart.length ? screenCart(cart, cfg) : screenCategories(catalog, cfg, nowIso, 'Your basket is empty.');
    if (!cart.length) S.current_step = 'browsing';
    ev('cart_sent', String(cart.length));
  }

  function clearAll(msg) {
    cart = []; pending = {}; nav = {};
    S.current_step = 'start';
    out.send = mButtons(msg || 'No problem, I have cleared your basket.',
      [{ id: 'order_now', title: 'Start again' }, { id: 'staff', title: 'Talk to Staff' }]);
    ev('cancelled', '');
  }

  function rangeFail(lat, lng) {
    if (!isFinite(cfg.shop_lat) || !isFinite(cfg.shop_lng) || !(cfg.delivery_radius_km > 0)) return null;
    var d = haversineKm(Number(lat), Number(lng), cfg.shop_lat, cfg.shop_lng);
    return d > cfg.delivery_radius_km ? d : null;
  }

  function refuseTooFar(d) {
    out.send = mText((cfg.too_far_message || 'Sorry, that address is about {km} km away and we only deliver within {radius} km.')
      .replace('{km}', d.toFixed(1)).replace('{radius}', String(cfg.delivery_radius_km)));
    ev('out_of_range', d.toFixed(2) + 'km', 'warn');
  }

  function askLocation() {
    S.current_step = 'awaiting_location';
    out.send = mLocation('Great! First, where should we deliver?\n\nTap the button below to share your location.');
    ev('location_asked', '');
  }

  function askName() {
    S.current_step = 'awaiting_name';
    var pn = S.profile_name || '';
    if (!pn) { S.current_step = 'awaiting_name_text'; out.send = mText('And who should we ask for on delivery?'); ev('name_asked', ''); return; }
    out.send = mButtons('Almost there. Who should we ask for on delivery?',
      [{ id: 'name_ok', title: cut('Use ' + pn, LEN.btn) }, { id: 'name_new', title: 'Another name' }]);
    ev('name_asked', '');
  }

  function beginOrder() {
    if (!open) { out.send = screenGreeting(cfg, false); ev('closed', ''); return; }
    if (!cfg.accepting_orders) { out.send = screenGreeting(cfg, true); ev('paused', ''); return; }
    var savedAddr = (cust && cust.address_text && cust.latitude !== null && cust.latitude !== undefined && cust.latitude !== '');
    if (savedAddr) {
      S.current_step = 'confirm_saved';
      out.send = mButtons('Welcome back! Deliver to the same address?\n\n' + cut(cust.address_text, 500),
        [{ id: 'addr_same', title: 'Same address' }, { id: 'addr_new', title: 'New address' }, { id: 'staff', title: 'Talk to Staff' }]);
      ev('saved_address_offered', '');
      return;
    }
    askLocation();
  }

  function useSavedAddress() {
    S.latitude = String(cust.latitude); S.longitude = String(cust.longitude);
    S.address_text = cust.address_text;
    S.customer_name = cust.name || S.profile_name || '';
    afterAddress('Delivering to your saved address.');
    ev('saved_address_used', '');
  }

  function placeOrder() {
    if (!cart.length) { showCart(); return; }
    if (!S.address_text || S.latitude === '' || S.longitude === '') {
      // Browsing via "Today's Prices" skips the address steps, so the guard has
      // to live at checkout. The basket is kept and we return straight to it.
      beginOrder();
      if (out.send && out.send.body) {
        out.send.body = cut(NUDGE + out.send.body, LEN.body);
      }
      ev('address_needed_at_checkout', String(cart.length));
      return;
    }
    var t = cartTotals(cart, cfg);
    if (cfg.min_order_value > 0 && t.subtotal < cfg.min_order_value) {
      S.current_step = 'cart_review';
      out.send = mButtons('Our minimum order is ' + money(cfg, cfg.min_order_value) +
        ' and your basket is ' + money(cfg, t.subtotal) + '. Please add a little more.',
        [{ id: 'add_more', title: 'Add more' }, { id: 'edit', title: 'Edit basket' }]);
      ev('below_minimum', t.subtotal, 'warn');
      return;
    }
    var oid = cfg.order_prefix + '-' + lp.stamp + '-' + digits(S.phone).slice(-4);
    var itemsText = cart.map(function (c) {
      return c.qty + ' x ' + c.item_name + ' ' + c.pack_label + ' = ' + money(cfg, c.line_total);
    }).join('\n');
    var map = (S.latitude && S.longitude) ? ('https://maps.google.com/?q=' + S.latitude + ',' + S.longitude) : '';

    out.order = {
      order_id: oid, created_at: nowIso,
      customer_phone: S.phone, customer_name: S.customer_name || S.profile_name || '', wa_id: S.wa_id || '',
      latitude: S.latitude === '' ? null : Number(S.latitude),
      longitude: S.longitude === '' ? null : Number(S.longitude),
      map_link: map, address_text: S.address_text || '',
      items_json: JSON.stringify(cart), items_text: itemsText,
      total_items: cart.reduce(function (a, c) { return a + c.qty; }, 0),
      subtotal: t.subtotal, delivery_fee: t.delivery_fee, total: t.total,
      payment_mode: 'COD', status: 'new', accepted_by: '', notes: '', version: 1
    };
    touchCustomer({ last_order_at: nowIso, order_count: Number((cust && cust.order_count) || 0) + 1 });

    out.send = mText('Order confirmed ✅\n\n' + oid + '\n\n' + itemsText +
      '\n\nSubtotal: ' + money(cfg, t.subtotal) +
      '\nDelivery: ' + (t.delivery_fee > 0 ? money(cfg, t.delivery_fee) : 'Free') +
      '\nTotal: ' + money(cfg, t.total) +
      '\n\nPayment: CASH ON DELIVERY' +
      '\nDelivering to: ' + (S.address_text || 'your saved address') +
      '\n\nWe will deliver ' + cfg.delivery_eta + '. Thank you for shopping with ' + cfg.business_name + '!');

    cart = []; pending = {}; nav = {};
    S.current_step = 'start';
    ev('order_confirmed', oid);
    out.event.ref_id = oid;
  }

  // ------------------------------------------------------------ free text
  function resolveTyped() {
    var lines = null;
    if (cfg.llm_enabled) lines = groundedLines(input.llm, typed);
    if (!lines) lines = parseOrderLines(typed);
    if (!lines.length) { showCategories('I did not catch that. Pick a section, or type an item name.'); return; }

    if (lines.length === 1) {
      var L = lines[0];
      var hits = searchGroups(L.name || L.raw, catalog, 8);
      if (!hits.length) {
        showCategories('Sorry, I could not find "' + cut(L.name || L.raw, 40) + '" in today’s list.');
        ev('no_match', L.name || L.raw);
        return;
      }
      if (hits.length > 1) {
        S.current_step = 'browsing';
        out.send = screenSearchResults(hits.slice(0, 9), cfg, L.name || L.raw);
        ev('search_results', String(hits.length));
        return;
      }
      var g = hits[0];
      var want = scaleAmount(L.amountText ? canonAmount(L.amountText) : null, L.qty);
      if (want) {
        var m = packForAmount(g, want);
        if (m) { addPack(m.pack, m.qty); return; }
      }
      if (L.qty && g.inStock.length === 1) { addPack(g.inStock[0], L.qty); return; }
      showGroup(g.group_code);
      return;
    }

    // Several items in one message: add everything unambiguous, ask about the rest.
    var added = [], unclear = [], missing = [], i;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var h = searchGroups(ln.name || ln.raw, catalog, 3);
      if (!h.length) { missing.push(ln.name || ln.raw); continue; }
      var grp = h[0];
      var w = scaleAmount(ln.amountText ? canonAmount(ln.amountText) : null, ln.qty);
      var mm = w ? packForAmount(grp, w) : null;
      if (mm) { cartAdd(cart, mm.pack, Math.min(mm.qty, cfg.max_qty)); added.push(mm.qty + ' x ' + mm.pack.item_name + ' ' + mm.pack.pack_label); continue; }
      if (grp.inStock.length === 1) {
        var q = Math.max(1, Math.min(ln.qty || 1, cfg.max_qty));
        cartAdd(cart, grp.inStock[0], q);
        added.push(q + ' x ' + grp.inStock[0].item_name + ' ' + grp.inStock[0].pack_label);
        continue;
      }
      unclear.push(grp);
    }
    var note = [];
    if (added.length) note.push('Added:\n' + added.join('\n'));
    if (missing.length) note.push('Not on today’s list: ' + missing.join(', '));
    if (unclear.length) {
      pending = {}; S.current_step = 'browsing';
      out.send = screenSearchResults(unclear.slice(0, 9), cfg, 'pack size needed');
      out.send.body = cut((note.join('\n\n') + '\n\nWhich pack size for these?').trim(), LEN.body);
      ev('partial_resolve', added.length + ' added, ' + unclear.length + ' unclear');
      return;
    }
    if (!added.length) { showCategories(note.join('\n\n') || 'I could not match those.'); return; }
    S.current_step = 'cart_review';
    out.send = screenAdded(cart, cfg, note.join('\n\n'));
    ev('items_added', String(added.length));
  }

  // ------------------------------------------------------------ routing
  var step = S.current_step;

  // Anything that reaches a human wins over everything else.
  if (tap === 'staff' || upper === 'STAFF' || upper === 'AGENT' || upper === 'HUMAN' || upper === 'SUPPORT') {
    startHandoff();
  } else if (step === 'human_handoff') {
    if (tap === 'resume' || upper === 'ORDER' || upper === 'ORDER NOW' || upper === 'MENU' || upper === 'BOT' || upper === 'RESUME') {
      out.handoff = { action: 'close', customer_phone: S.phone,
        customer_name: S.customer_name || S.profile_name || '',
        last_message_text: '(customer resumed ordering)', last_message_at: nowIso,
        status: 'closed', closed_at: nowIso };
      beginOrder();
    } else {
      handoffQuiet();
    }
  } else if (upper === 'HELP') {
    out.send = mButtons(HELP_TEXT, [{ id: 'order_now', title: 'Order Now' }, { id: 'staff', title: 'Talk to Staff' }]);
    ev('help_sent', '');
  } else if (tap === 'cancel' || upper === 'CANCEL') {
    clearAll();
  } else if (tap === 'order_now' || upper === 'ORDER' || upper === 'ORDER NOW' || upper === 'START') {
    beginOrder();
  } else if (tap === 'prices' || upper === 'PRICES' || upper === 'MENU' || upper === 'LIST') {
    showCategories('Here is today’s list.');
  } else if (tap === 'cart' || upper === 'CART' || upper === 'BASKET') {
    showCart();
  } else if (tap === 'cats' || tap === 'add_more') {
    showCategories();
  } else if (tap === 'checkout' || tap === 'confirm' || upper === 'CONFIRM' || upper === 'DONE') {
    if (tap === 'checkout') showCart(); else placeOrder();
  } else if (tap === 'edit') {
    if (!cart.length) { showCart(); } else { S.current_step = 'edit_cart'; out.send = screenEdit(cart, cfg); ev('edit_sent', ''); }
  } else if (tap.indexOf('rm:') === 0) {
    var rc = tap.slice(3), before = cart.length;
    cart = cart.filter(function (c) { return c.item_code !== rc; });
    ev('item_removed', rc + (cart.length === before ? ' (not found)' : ''));
    if (!cart.length) { showCategories('Your basket is empty now.'); } else { showCart(); }
  } else if (tap.indexOf('cat:') === 0) {
    showCategory(parseInt(tap.slice(4), 10), 0);
  } else if (tap.indexOf('pg:') === 0) {
    var pp = tap.slice(3).split(':');
    showCategory(parseInt(pp[0], 10), parseInt(pp[1], 10) || 0);
  } else if (tap.indexOf('grp:') === 0) {
    showGroup(tap.slice(4));
  } else if (tap.indexOf('pk:') === 0) {
    var pk = packByCode(tap.slice(3));
    if (pk) askQty(pk); else showCategories();
  } else if (tap.indexOf('q:') === 0) {
    var qp = packByCode(pending.item_code || '');
    if (qp) addPack(qp, parseInt(tap.slice(2), 10) || 1); else showCategories();
  } else if (tap === 'srch') {
    S.current_step = 'awaiting_search';
    out.send = mText('What are you looking for? Type the name, for example "tomatoes" or "2 kg onions".');
    ev('search_asked', '');
  } else if (tap === 'addr_same' && cust && cust.address_text) {
    useSavedAddress();
  } else if (tap === 'addr_new') {
    askLocation();
  } else if (tap === 'addr_ok' && pending.addr) {
    S.address_text = pending.addr.text || S.address_text;
    pending = {};
    touchCustomer();
    askName();
  } else if (tap === 'addr_ok' && !pending.addr) {
    S.current_step = 'awaiting_address';
    out.send = mText('Sorry, I lost that address. Please type it again - flat or villa number, building, street and a nearby landmark.');
    ev('address_retry', 'no pending address');
  } else if (tap === 'addr_fix') {
    S.current_step = 'awaiting_address';
    pending = {};
    out.send = mText('No problem - please type the address again, with flat or villa number, building, street and a nearby landmark.');
    ev('address_retry', '');
  } else if (tap === 'name_ok') {
    S.customer_name = S.profile_name || '';
    touchCustomer();
    afterAddress('Thanks ' + (S.customer_name || '') + '! Here is today’s list.');
  } else if (tap === 'name_new') {
    S.current_step = 'awaiting_name_text';
    out.send = mText('Sure - what name should we use?');
    ev('name_asked', '');
  } else if (GREETINGS.indexOf(upper) >= 0) {
    // Mid-order "hi" must not be searched for as a product, and must not throw
    // away a basket the customer has already filled.
    if (cart.length) { showCart(); }
    else { out.send = screenGreeting(cfg, open); ev('welcome_sent', ''); }
  } else if (isNew && !tap && !typed && !hasLoc) {
    out.send = screenGreeting(cfg, open);
    ev('welcome_sent', '');
  } else if (hasLoc && (step === 'awaiting_location' || step === 'start' || step === 'confirm_saved' || isNew)) {
    var far = rangeFail(inb.latitude, inb.longitude);
    if (far !== null) { S.current_step = 'awaiting_location'; refuseTooFar(far); }
    else {
      S.latitude = String(inb.latitude); S.longitude = String(inb.longitude);
      S.current_step = 'awaiting_address';
      out.send = mText('Got your location 📍\n\nNow please type your address - flat or villa number, building, street and a nearby landmark.');
      ev('location_received', '');
    }
  } else if (step === 'awaiting_location') {
    askLocation();
  } else if (step === 'awaiting_address' && typed) {
    var tidy = (cfg.llm_enabled && input.llm && input.llm.address) ? input.llm.address : null;
    var pretty = typed;
    if (tidy) {
      var bits = [tidy.flat, tidy.building, tidy.street, tidy.landmark]
        .filter(function (x) { return x && String(x).trim(); });
      if (bits.length >= 2) pretty = bits.join(', ');
    }
    pending = { addr: { text: pretty, raw: typed, parts: tidy || null } };
    S.current_step = 'confirm_address';
    out.send = mButtons('Let me read that back:\n\n' + pretty + '\n\nIs that right?',
      [{ id: 'addr_ok', title: 'Yes, correct' }, { id: 'addr_fix', title: 'Let me fix it' }]);
    ev('address_confirm', '');
  } else if (step === 'awaiting_name_text' && typed) {
    S.customer_name = cut(typed, 60);
    touchCustomer();
    afterAddress('Thanks ' + S.customer_name + '! Here is today’s list.');
  } else if (step === 'awaiting_qty' && /^\d{1,4}$/.test(upper)) {
    var qpk = packByCode(pending.item_code || '');
    if (qpk) addPack(qpk, parseInt(upper, 10)); else showCategories();
  } else if (typed) {
    if (step === 'start' || step === 'confirm_saved') {
      // They typed instead of tapping. If it looks like an order, honour it;
      // otherwise greet.
      if (searchGroups(typed, catalog, 1).length) beginOrderThenResolve();
      else { out.send = screenGreeting(cfg, open); ev('welcome_sent', ''); }
    } else {
      resolveTyped();
    }
  } else {
    out.send = screenGreeting(cfg, open);
    ev('welcome_sent', '');
  }

  function beginOrderThenResolve() {
    // A customer who already has an address can start ordering by just typing.
    var savedAddr = (cust && cust.address_text && cust.latitude !== null && cust.latitude !== undefined && cust.latitude !== '');
    if (savedAddr) {
      S.latitude = String(cust.latitude); S.longitude = String(cust.longitude);
      S.address_text = cust.address_text;
      S.customer_name = cust.name || S.profile_name || '';
      resolveTyped();
    } else {
      beginOrder();
    }
  }

  S.cart_json = JSON.stringify(cart);
  S.pending_json = JSON.stringify(pending || {});
  S.nav_json = JSON.stringify(nav || {});
  S.last_bot_message = out.send ? cut(out.send.body || '', 400) : '';
  out.session = S;
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runEngine: runEngine, buildCatalog: buildCatalog, parseConfig: parseConfig,
    parseOrderLines: parseOrderLines, canonAmount: canonAmount, packForAmount: packForAmount,
    searchGroups: searchGroups, groundedLines: groundedLines, cartTotals: cartTotals,
    scaleAmount: scaleAmount,
    isOpen: isOpen, haversineKm: haversineKm
  };
}
