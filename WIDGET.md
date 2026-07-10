# clerk.io website embed — merchant integration

For customers who **already have a site** and want clerk.io in their customer-care experience.

## What you get

| Piece | Description |
|--------|-------------|
| **Dangling sign** | Floating `clerk` bubble fixed bottom-right on their website |
| **Care unit** | Chat panel that opens on click — talks to clerk.io API |
| **Standby (default)** | Clerk **always** drafts answers and queues humans; **never** auto-replies until mode is `live` |
| **Always learning** | Every human resolution becomes an exemplar + learning event |

## Install (2 minutes)

1. Run SQL: `supabase/schema-widget.sql` in Supabase.
2. Open **https://YOUR-HOST/install.html**
3. Provision a key (admin token + business name + wallet).
4. Paste the snippet before `</body>` on the merchant site:

```html
<script
  src="https://clerk-io.onrender.com/widget/v1.js"
  data-clerk-key="pk_live_…"
  data-clerk-base="https://clerk-io.onrender.com"
  async
></script>
```

## Modes

| Mode | Visitor sees | Clerk does |
|------|----------------|------------|
| **`standby`** | Handoff message; human takes over | Drafts every message, stores shadow drafts, **learns from every human resolve** |
| **`live`** | Auto-reply when confidence ≥ threshold | Same learning; auto-send when confident |

Standby is the correct default for a new merchant: clerk.io is never “off” — it’s always watching and learning.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/widget/v1.js` | Embed script |
| POST | `/api/widget/session` | Open visitor session |
| POST | `/api/widget/message` | Customer chat turn |
| POST | `/api/widget/learn` | Human finished case → train |
| POST | `/admin/widget/provision` | Create public key + snippet |
| POST | `/webhooks/resolved-by-human` | Same learning via helpdesk webhook (`humanReply` field) |

### Learn payload

```json
{
  "merchantId": "uuid",
  "customerMessage": "Where is my order?",
  "humanReply": "It ships tomorrow — tracking is …",
  "ticketHash": "optional",
  "sessionId": "optional"
}
```

Auth: `Authorization: Bearer ADMIN_TOKEN` **or** `X-Clerk-Signature` HMAC of body with `WEBHOOK_SECRET`.

## Security

- **Public key** only on the website (not the service role key).
- Optional **allowed origins** list on the merchant row.
- Rate limits on all widget routes.
- PII scrub before LLM.

## Demo without SQL

If widget tables are missing, provision/session will error until `schema-widget.sql` is applied.
