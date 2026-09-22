# App Review — advanced access for the DailyFresh app

App **Dailyfresh**, ID `1096379283082781`, business portfolio `1651777435922327`.
We are applying as a **Tech Provider**: shops connect their own WhatsApp number through
Embedded Signup and we send and receive messages on their behalf.

Two permissions, **two separate videos**. Meta rejects a single video that covers both.

| Permission | The video must show |
|---|---|
| `whatsapp_business_messaging` | A message composed in **our** business interface, sent, and arriving in a real WhatsApp client |
| `whatsapp_business_management` | A **message template** being created in our business interface |

`whatsapp_business_manage_events` is granted automatically once messaging is approved. Do not
request it separately — asking for permissions you don't demonstrate is the single most common
rejection reason.

---

## 1. Before you open the submission form

| Item | Where | State |
|---|---|---|
| Business verification | Business portfolio | ✅ Approved |
| Privacy policy URL | App settings → Basic | ✅ `https://www.aflatus.com/privacypolicy/` |
| **Terms of service URL** | App settings → Basic | ⚠️ **still Meta's `facebook.com` placeholder** → change to `https://dailyfresh.aflatus.com/terms` |
| Data deletion URL | App settings → Basic | ✅ `https://dailyfresh.aflatus.com/datadeletion` |
| Contact email verified | App settings → Basic | ⚠️ confirm `info@aflatus.com` shows as verified |
| App icon, 1024×1024 | App settings → Basic | ✅ |
| Category | App settings → Basic | ✅ Business and pages |
| Working prototype | — | ✅ bot live on the test number, console live |

The terms URL is the one that will bounce the submission. It takes a minute: **App settings →
Basic → Terms of Service URL**, paste, **Save changes**.

---

## 2. What to record with

- **Screen recording, not screenshots.** Screenshots are rejected.
- Record the **laptop screen** and film the **phone** in the same take where a phone is
  involved — or use a phone mirroring window (Windows Phone Link, scrcpy) so both are on one
  screen. One continuous take is far more convincing than a cut.
- **Show the browser address bar** so `dailyfresh.aflatus.com` is visible. Reviewers look for
  evidence that this is your interface and not a screenshot of WhatsApp Manager.
- 1–3 minutes each. No narration needed; on-screen actions are enough. Slow, deliberate clicks.
- English UI.
- No password typing on camera — sign in before you start recording.

---

## 3. Video 1 — `whatsapp_business_messaging`

**Premise shown:** a shop's staff answer a customer from our dashboard, and the customer
receives it in WhatsApp.

Record this, in order:

1. **Start on the console**, signed in, at `https://dailyfresh.aflatus.com`, address bar
   visible. Pause a beat on the **Orders** tab so the reviewer sees a real business tool.
2. Switch to the **Chats** tab. A customer is waiting — name, number, and their last message.
   *(Set this up first: from the test phone, message the bot and tap **💬 Talk to Staff**.)*
3. Click into the reply box and **type a reply**, e.g.
   `Hello! Yes, we have fresh tomatoes today at AED 6.50 per kg. Shall I add 1 kg to your order?`
4. Click **Send**. Show the `Sent on WhatsApp` confirmation.
5. **Cut to / pan to the phone.** Show the message arriving in the WhatsApp chat, with the
   timestamp matching.
6. **Reply from the phone** ("Yes please") and show it appearing back in the Chats tab after a
   refresh. This demonstrates receiving as well as sending — the permission covers both.

**What must be on screen at least once:** our interface, the send action, the message inside a
real WhatsApp client.

**Do not** show WhatsApp Manager, the Graph API Explorer, or a Postman call. Reviewers read that
as "they have no product".

---

## 4. Video 2 — `whatsapp_business_management`

**Premise shown:** a shop's staff create a WhatsApp message template from our dashboard.

1. **Start on the console**, address bar visible. Open the **Templates** tab.
2. Show the existing templates list with their approval statuses. Pause a beat.
3. Click **New template** and fill the form on camera:
   - Name `order_out_for_delivery`
   - Category **Utility**
   - Language **English**
   - Heading `Your order is on its way`
   - Message
     `Hello {{1}}, your DailyFresh order {{2}} has left the shop and will reach you in about 30 minutes. Payment is cash on delivery.`
   - Quick reply buttons `Track order, Talk to us`
4. Click **Send for approval**.
5. Show the toast, then the **new template appearing in the list with status PENDING**
   (or APPROVED — Meta often approves utility templates in under a minute). Refresh once if
   needed so the status is unmistakably read back from the WhatsApp account.

That read-back is the point of the video: it proves we are managing assets on the account, not
just posting a form into our own database.

---

## 5. The written descriptions

Paste these into the "Tell us how you're using this permission" box. Meta reviews the text
alongside the video and will reject a video with a thin description.

### `whatsapp_business_messaging`

> DailyFresh is a WhatsApp ordering assistant operated by AFLATUS OPC PVT LTD for grocery and
> fresh-produce shops in the UAE. We are a Tech Provider: each shop connects its own WhatsApp
> Business number to our app through Embedded Signup, using Coexistence so the shop's staff keep
> using the WhatsApp Business app on the same number.
>
> We need `whatsapp_business_messaging` to send and receive messages on behalf of those shops.
> Specifically: we receive the customer's inbound message through the Cloud API webhook, and we
> reply with interactive messages — reply buttons and lists — that let the customer browse the
> shop's price list, pick pack sizes, share a delivery location, and confirm an order for cash on
> delivery. When a customer asks for a person, the conversation is handed to the shop's staff,
> who answer the customer from our web dashboard; that reply is sent with this permission. We also
> send each shop a one-time code over WhatsApp to sign in to that dashboard.
>
> The attached video shows our business-facing dashboard at dailyfresh.aflatus.com: a staff member
> reading a waiting customer, typing a reply, sending it, and the message arriving in the
> customer's WhatsApp.
>
> We only message customers who have messaged the shop first, and every conversation can be ended
> by the customer at any time.

### `whatsapp_business_management`

> DailyFresh is a WhatsApp ordering assistant operated by AFLATUS OPC PVT LTD for grocery shops in
> the UAE, and we are applying as a Tech Provider. Shops connect their own WhatsApp Business
> Account to our app through Embedded Signup.
>
> We need `whatsapp_business_management` to manage our clients' WhatsApp Business Accounts on their
> behalf. Specifically: after a shop completes Embedded Signup we read the WhatsApp Business
> Account the authorisation is scoped to, read its phone numbers, and subscribe our app to that
> account's webhooks so the shop's messages reach us. We then let the shop's staff create and
> review message templates from our dashboard — for example an order-status template used to tell
> a customer their delivery has left the shop, more than 24 hours after they last wrote to us.
> Staff see each template's approval status and rejection reason in our dashboard.
>
> The attached video shows our dashboard at dailyfresh.aflatus.com: the shop's existing templates
> with their statuses, a new utility template being composed and submitted, and the new template
> read back from the WhatsApp Business Account with its status.

---

## 6. Filling in the form

**App Review → Permissions and features**, find each permission, **Request advanced access**.

- One permission at a time; each gets its own video and its own description.
- Attach the video to the permission it belongs to. Attaching both videos to both permissions
  reads as "multiple permissions in one video".
- **Verification steps / test instructions** box: reviewers rarely sign in to a WhatsApp Tech
  Provider tool, but fill it anyway:

> Our dashboard requires a WhatsApp one-time code sent to the shop's own registered number, so it
> cannot be signed into with a test account. The attached screencast shows the full flow. If you
> need live access, email info@aflatus.com and we will schedule a screen share.

- After attaching everything, **Submit for review** on the App Review page. A submission left in
  draft is never looked at — a surprisingly common way to lose a week.

Expect a decision in roughly **24 hours**, sometimes a few days.

---

## 7. If it comes back rejected

| Rejection | Usually means |
|---|---|
| "Could not verify the permission is used as described" | The video showed WhatsApp Manager or an API tool rather than your own interface |
| "Multiple permissions in one video" | Split the videos, resubmit each separately |
| "Requesting unnecessary permissions" | Drop anything you did not demonstrate |
| "Business verification required" | Portfolio verification lapsed — recheck the portfolio, not the app |

Rejections are cheap to fix and resubmission is unlimited. Read the reviewer's note literally;
it almost always names the exact frame that was missing.

---

## 8. What this unlocks

Advanced access is what lets a shop **other than us** — Baqala, on +971 50 529 0671 — complete
Embedded Signup and have the bot serve their customers. Until then the app works only on the test
number and on numbers in the app's own allow-list.
