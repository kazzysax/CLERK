# Make clerk.io available on your website

This guide is for **merchants** who already have a site (Shopify, WordPress, Webflow, custom HTML, etc.) and want a **floating clerk.io chat** for customers — without rebuilding your stack.

---

## What customers will see

1. A **floating bubble** (bottom-right) labeled **clerk**  
2. When they click it: a **chat panel** (your care unit)  
3. They type a question → clerk.io answers or hands off to your team  

You stay in control:

| Mode | What happens |
|------|----------------|
| **Standby** (recommended first) | clerk.io **drafts** every reply and **learns** when your team answers. Customers get a short handoff message — no auto-guessing. |
| **Live** | Same learning, plus clerk.io **auto-replies** when it is confident enough. |

---

## Before you start

You need:

1. Access to **edit your website** (theme / footer / tag manager).  
2. Your **clerk.io host URL** (example: `https://clerk-io.onrender.com`).  
3. An **install key** (`pk_live_…`) from the clerk.io team or the install page.  
4. Optional: your **wallet address** on X Layer if you use onchain escrow later.

If you don’t have a key yet, open:

**`https://YOUR-CLERK-HOST/install.html`**

…or ask your operator to generate one for you.

---

## Step 1 — Get your install snippet

### Option A — Self-serve (install page)

1. Go to **`/install.html`** on the clerk.io service.  
2. Enter the **admin token** (from your operator — not a public password).  
3. Fill in:
   - Business name  
   - Wallet address (X Layer)  
   - Mode: **standby** or **live**  
   - Allowed origins (optional): e.g. `https://yoursite.com`  
4. Click **Generate install snippet**.  
5. Click **Copy snippet**.

### Option B — Operator sends you a snippet

You should receive something like:

```html
<!-- clerk.io embed — paste before </body> -->
<script
  src="https://clerk-io.onrender.com/widget/v1.js"
  data-clerk-key="pk_live_YOUR_KEY_HERE"
  data-clerk-base="https://clerk-io.onrender.com"
  async
></script>
```

Keep `data-clerk-key` private to your business (don’t post it in public forums). It only opens *your* care unit, but treat it like an API key.

---

## Step 2 — Paste on your website

Add the snippet **once**, on every page where support should appear. Best place: **just before the closing `</body>` tag**.

### Custom HTML / static site

Edit your layout template → paste before `</body>` → save & publish.

### WordPress

1. **Appearance → Theme File Editor** → `footer.php`, **or**  
2. A plugin like “Insert Headers and Footers” / “WPCode” → **Footer** section.  
3. Paste the snippet → save.

### Shopify

1. **Online Store → Themes → Edit code**.  
2. Open `theme.liquid`.  
3. Paste the snippet **above** `</body>`.  
4. Save.

### Webflow

1. **Project settings → Custom code → Footer code**.  
2. Paste the snippet.  
3. Publish the site.

### Squarespace / Wix

Use **Settings → Advanced → Code injection → Footer** (or the equivalent custom code block) and paste the snippet site-wide.

### Google Tag Manager

1. New tag → **Custom HTML**.  
2. Paste the full `<script …>` block.  
3. Trigger: **All Pages**.  
4. Publish the container.

---

## Step 3 — Check that it works

1. Open **your live site** (not only the editor preview if scripts are blocked there).  
2. Look for the **floating circle** bottom-right.  
3. Click it → chat should open with a greeting.  
4. Send a test message:
   - **Standby:** you should get a handoff / “team will help” style reply.  
   - **Live:** high-confidence answers may reply as clerk.io.

If the bubble is missing:

- Hard-refresh (Ctrl+F5 / Cmd+Shift+R).  
- Disable ad blockers for your domain.  
- Confirm the script URL opens in a new tab (should download/show JavaScript).  
- Confirm you published the theme/site after pasting.

If chat opens but errors:

- Tell your operator: widget tables may need `schema-widget.sql` in Supabase.  
- Confirm `data-clerk-base` matches the real clerk.io host.  
- If you set **allowed origins**, your exact site URL (`https://…`) must be listed.

---

## Step 4 — Keep clerk.io learning (important)

clerk.io is designed to **always learn when humans resolve cases**.

Whenever your team answers a customer (helpdesk, email, or desk tool), that answer should be sent to clerk.io so it improves next time.

### Simple API (your developer / helpdesk can wire this)

```http
POST https://YOUR-CLERK-HOST/api/widget/learn
Authorization: Bearer ADMIN_TOKEN
Content-Type: application/json

{
  "merchantId": "YOUR_MERCHANT_UUID",
  "customerMessage": "Where is my order?",
  "humanReply": "It ships tomorrow — tracking is ABC123."
}
```

Or use the signed webhook your operator already configured:

```http
POST /webhooks/resolved-by-human
```

with `humanReply` (and ticket ids) in the body.

**You do not need to train a model yourself.** Real replies from your team *are* the training.

---

## Standby vs live — when to switch

| Start with **standby** if… | Switch to **live** when… |
|----------------------------|---------------------------|
| You’re new to clerk.io | Shadow drafts look good for weeks |
| You want zero risk of a wrong auto-reply | Confidence + ratings look solid |
| You’re still uploading FAQs / policies | Reopen rate stays low |

Your operator can flip mode on the merchant record (`standby` → `live`) when you’re ready.

---

## Branding tips

Ask your operator to set (or use provision options):

- **Widget title** — e.g. “Acme Support”  
- **Greeting** — first line customers see  
- **Accent color** — matches your brand  

The bubble still shows clerk.io under the hood; the panel title can be yours.

---

## Security & privacy (plain language)

- The snippet uses a **public site key**, not your database password.  
- Chat content is stored for **your merchant only** (isolated memory).  
- Card-number patterns are scrubbed before AI drafting.  
- Optional **allowed origins** lock the widget to *your* domain only.  
- Onchain records (if you use escrow) store **hashes**, not customer names.

---

## Checklist

- [ ] Got `pk_live_…` key and host URL  
- [ ] Snippet pasted before `</body>` (or via Tag Manager footer)  
- [ ] Site published  
- [ ] Bubble visible on a live page  
- [ ] Test message works  
- [ ] Human replies flow into learning (`/api/widget/learn` or webhook)  
- [ ] Mode is **standby** until you’re ready for auto-reply  

---

## Need help?

| Link | Purpose |
|------|---------|
| `/install.html` | Generate key + snippet |
| `/portal.html` | Wallet / escrow console |
| `/WIDGET.md` | Technical API reference |
| `/reputation.html` | Public onchain track record |

**Live service example:** https://clerk-io.onrender.com  

Paste-ready snippet host:

```text
https://clerk-io.onrender.com/widget/v1.js
```

---

*clerk.io — support that only gets paid when it works. On your site in one script tag.*
