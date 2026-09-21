# DailyFresh — WhatsApp ordering bot for Baqala

A tap-first WhatsApp ordering bot for **Baqala** (baqala.ae), the UAE fruit,
vegetable and grocery delivery service. Standalone project — it shares nothing
with Ordo: its own Meta app, its own n8n workflows, its own `df_*` data tables
and its own PWA.

Target number: **+971 50 529 0671**, onboarded via WhatsApp **Coexistence** so
Baqala's staff keep answering chats from the WhatsApp Business App on the same
phone. Demo runs on the Meta Cloud API **test number** first.

## Design in one paragraph

The customer should almost never type. The greeting is three buttons; browsing is
category and item lists; pack size and quantity are buttons; checkout is a button.
A returning customer places a repeat order without typing a single character,
because their name and address are remembered in `df_customers`. When they *do*
type, a local **Ollama** model (`llama3.2:1b`) only splits and tidies the words —
it never decides, never matches an item and never touches a price. All pricing,
matching and totals are deterministic.

## Layout

```
n8n/
  engine.js                     the conversation state machine - pure, testable
  test-engine.js                62 local scenario checks (node n8n/test-engine.js)
  build-workflow.py             emits the n8n workflow JSON, inlining engine.js
  deploy.py                     pushes tables / seed rows / workflow over the n8n API
  tables.json                   df_* data table schemas
  seed/df_config.json           shop settings (values marked TO-CONFIRM)
  seed/build_catalog.py         generates the seed catalogue + the Sheet template
  seed/df_catalog.seed.json     44 pack rows across 31 products, 6 categories
  build/                        generated - do not edit by hand
docs/
  baqala-price-sheet-template.csv   the Google Sheet Baqala will maintain
console/                        the PWA (orders, handoff alerts, price management)
```

## Working on it

```bash
node n8n/test-engine.js           # run the scenario suite
node n8n/test-engine.js --show    # ...and print the chat transcripts
python n8n/seed/build_catalog.py  # regenerate catalogue + sheet template
python n8n/build-workflow.py      # regenerate the workflow JSON
```

`engine.js` is the only place the conversation logic lives. It is inlined into
the workflow's Engine node at build time, so **what the tests exercise is what
runs**. Never edit the generated JSON — change `engine.js` and rebuild.

## Deploying

Needs an n8n API key (n8n → Settings → n8n API → Create an API key):

```bash
N8N_API_KEY=xxx python n8n/deploy.py all      # tables + seed + workflow
N8N_API_KEY=xxx python n8n/deploy.py reset    # empty sessions/customers/handoffs/orders
N8N_API_KEY=xxx python n8n/live-test.py       # drive a conversation through the live webhook
N8N_API_KEY=xxx python n8n/rows.py df_orders  # read any table back
```

Idempotent: existing tables are left alone, seed rows load only into empty
tables, and the workflow is updated in place so its webhook URL never changes.

`reset` drops and recreates four tables, because the n8n public API has **no
row-delete** — it answers 405. Never point it at `df_config` or `df_catalog`.

## The data

| Table | Holds |
|---|---|
| `df_config` | shop settings as key/value — hours, fees, radius, tokens |
| `df_catalog` | one row per **sellable pack**; `group_code` groups packs of a product |
| `df_customers` | name + saved address — what makes repeat orders typing-free |
| `df_sessions` | live conversation state, 30-minute TTL |
| `df_orders` | confirmed orders, COD |
| `df_handoffs` | open "talk to staff" conversations |
| `df_events` | audit trail |

One catalogue row per pack is deliberate: each row carries its own price, so the
cart stays `line_total = price × qty` with no pack dimension threaded through
search, cart, orders and the price editor.

## Known state

**Deployed and verified end to end**
- Workflow **`f5rSxsEUoW4Rif9z`**, 39 nodes, **active**, webhook
  `https://n8n.srv1047573.hstgr.cloud/webhook/dailyfresh/wa`.
- All seven `df_*` tables exist; `df_config` (29 rows) and `df_catalog` (44 rows)
  are seeded.
- Meta's GET verification handshake echoes the challenge; a POST message runs the
  full chain to `Append Event`.
- A complete conversation was driven through the live webhook: greeting → location
  → address → name → browse → pack → quantity → typed multi-item → basket →
  confirm. Order `BQ-…` was written with the right items, totals, COD and map
  link; the customer row saved the address; the handoff opened and closed.
- 71 local scenarios pass (`node n8n/test-engine.js`).

**Proven on real WhatsApp (2026-09-21)**
A live order was placed end to end from a real handset against the Meta test
number — greeting, browse, search, pack picker, quantity, basket, edit, cancel,
location, address, name, confirm. Order `BQ-20260921214054-3632`:
3 x Parsley + 3 x Cauliflower + 2 x Milk, subtotal 38.50 + 5.00 delivery =
**AED 43.50**, `payment_mode COD`, `status new`, with map link and saved address.
The customer row saved the address for next time and the session reset cleanly.
`Notify Order` failed with *"URL parameter cannot be empty"* (no PWA yet) and
`onError: continueRegularOutput` kept the chain running — as designed.

**Three bugs the live runs caught that local tests could not**
1. `Has Reply?` read `$json.has_reply`, but after the persist-before-send reorder
   it sits downstream of `Upsert Session`, whose item is the session row. The IF
   silently took the false branch and the bot never replied — while the execution
   still reported `success`. `build-workflow.py` now refuses to build if any
   post-Engine IF reads those flags without `$('Engine')`.
2. Browsing via *Today's Prices* skipped the address steps, so checkout would
   write an order with no address and no map link. Checkout now refuses, keeps
   the basket, collects the address and returns to the basket.
3. "Basket: 1 item, total AED 70.00" silently included delivery; it now reads
   "AED 65.00 + AED 5.00 delivery".

**The console (built 2026-09-21)**
- `DailyFresh - Console API` (n8n `ZTwGqa51sJDglpHr`, `POST /webhook/df/console`),
  the only thing the PWA talks to — so the container holds **no n8n credentials**
  and can only do four things: read state, apply a narrow set of updates, send a
  login code, check a login code. Writes are read-merge-upsert, so a price-only
  edit cannot blank an item's name, and `config` writes are limited to an
  allow-list (`access_token` is not editable from the console).
- `console/` — Express + a no-framework PWA: orders with accept / reject /
  delivered, a chats queue for handoffs, price and stock editing, shop settings,
  and Web Push. Session is a signed HttpOnly cookie; login is a 6-digit code sent
  over WhatsApp to `owner_phone` only, rate limited on both sides.
- Verified locally against live data: signed-in state returned the real order,
  a tampered cookie was rejected, **Accept** moved the order to `accepted` with
  `accepted_by` set to the signed-in phone, a price edit persisted with the
  item's name intact, and `/api/notify` rejected a wrong or missing admin token.

**Not built yet**
- `DailyFresh - Price Sync` (Google Sheet → `df_catalog`).
- Embedded Signup / Coexistence onboarding (Phase 5).

**The console is not deployed yet** — it needs two things:
1. An `A` record for `dailyfresh.aflatus.com` → `72.60.203.152` (aflatus.com DNS
   is not in the Hostinger account, so it has to be added at the real registrar).
2. A way to get `console/` onto the VPS. The Hostinger API can create a Docker
   Compose project but cannot upload files, and no SSH key here authenticates —
   so either push this folder to a git repo and build from it, or upload it by
   hand to `/docker/dailyfresh/`.
Once it is up, set `console_notify_url` in `df_config` to
`https://dailyfresh.aflatus.com/api/notify` and the bot's order and handoff
pushes start landing on the shop's phone.

**Meta app (configured 2026-09-21)**
- App `Dailyfresh` = `1096379283082781`, business portfolio `1651777435922327`.
- Required fields complete: category *Business and pages*, privacy policy
  `https://www.aflatus.com/privacypolicy/`, 1024x1024 icon
  (`docs/brand/make-icon.py` regenerates it). The "ineligible for submission"
  banner is cleared.
- Test number **+1 (555) 202-3155**, `phone_number_id` **1220660391138125**,
  WABA **1735394911125531** — both written into `df_config`.
- Webhook `https://n8n.srv1047573.hstgr.cloud/webhook/dailyfresh/wa` verified by
  Meta (n8n execution 9515 answered their real `hub.challenge`), and the
  **`messages` field is subscribed** — confirmed via the Graph API as
  `fields: ["messages"], enabled: true`.
- Business verification: **Approved**. Permissions
  `whatsapp_business_messaging` / `whatsapp_business_management` are at
  *Ready for testing* (standard access).

**Waiting on**
- **`access_token` in `df_config`** — the only missing piece before the bot can
  reply. Set it without it touching shell history:
  `N8N_API_KEY=xxx python n8n/config.py access_token --stdin`
  The dashboard token is temporary; a **System User token with expiry Never** is
  what a running bot needs.
- **Recipient allow-list**: a test number only messages up to 5 pre-approved
  numbers. Add your own WhatsApp number in Step 1 of the use case.
- **App Review** for advanced access, which is what lets you onboard Baqala as a
  Tech Provider. It needs screencasts: one showing a message send, one showing
  template creation. Business verification is already done.
- The app is **Unpublished**; Meta warns that only test webhooks are delivered
  while that is true. Watch for this if real messages do not arrive.
- Terms of Service and data-deletion URLs are still Meta's placeholder
  `https://www.facebook.com/` — replace before App Review.
- Baqala's real figures for every `TO-CONFIRM` value in `seed/df_config.json` —
  opening hours, depot coordinates, delivery radius and fee, minimum order.

⚠️ **Live config was widened for testing and must be restored before any Baqala
demo**: `delivery_radius_km` is **5000** (real: ~15 km) so a tester in India is
not refused, and hours are **00:01–23:59** (real: Baqala's trading hours). Check
with `python n8n/config.py` before showing anything to the client.

## Things to watch

- **Both webhook outputs must stay wired.** An n8n webhook with
  `multipleMethods` has one output per method: output 0 GET, output 1 POST.
  Wiring only output 0 gives a webhook that verifies perfectly with Meta and then
  silently drops every message, with executions still showing `success`.
- **Meta interactive limits**: 3 buttons, 10 list rows *total*, body 1024, button
  label 20, row title 24, row description 72. `engine.js` clamps to these and the
  test suite asserts them on every screen.
- **The minimum order matters more than it looks.** At the placeholder AED 30, a
  single-item basket is usually below it — this rejected the confirm step twice
  during live testing. Confirm the real figure with Baqala.
- **Read the session AFTER the model call.** Ollama can take seconds; when the
  only session read sat before it, a second message read pre-update state and the
  slow execution then overwrote the newer one. `Read Session Fresh` exists for
  exactly this, and the session is persisted *before* the outbound send.
- **A tap's title is not customer input.** Button and list replies carry a title
  we wrote; the engine ignores it and uses the id. Treating it as text once
  stored "Yes, correct" as a delivery address.
- **The webhook is live and unauthenticated.** It was activated for testing.
  Anyone who learns the path can write rows, so add the HMAC check (or deactivate
  it) before this is in front of customers.
- **`console_admin_token` currently lives in `df_config`.** Move it to an n8n
  credential before this is in front of real customers.
- **The webhook has no `X-Hub-Signature-256` check.** Add it at the reverse proxy
  before Baqala's customers reach it.
