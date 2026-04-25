# GSB Realtor Agent Setup

This agent receives website leads, scores them, stores them in `brain.db`, sends Telegram alerts, and saves reply drafts in `C:/gsb-100/data/lead-drafts`.

## PM2 Process

`gsb-realtor-agent`

## Local Endpoints

- Health: `http://localhost:8787/health`
- Recent leads: `http://localhost:8787/leads`
- Lead webhook: `http://localhost:8787/webhooks/gsb-realtor/lead`

## Required `.env`

```env
GSB_REALTOR_AGENT_PORT=8787
GSB_LEAD_WEBHOOK_TOKEN=change-me-long-random-token
```

## n8n / Website POST Example

Send JSON to:

`POST http://localhost:8787/webhooks/gsb-realtor/lead`

Header:

`x-gsb-webhook-token: YOUR_TOKEN`

Body:

```json
{
  "source": "gsbrealtor.com/contact",
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "8015551212",
  "message": "Looking for a strip center in Utah under 4.5M with strong traffic.",
  "propertyType": "retail",
  "timeline": "this month",
  "budget": "4.5M",
  "city": "Salt Lake City",
  "state": "UT",
  "page": "https://www.gsbrealtor.com/contact"
}
```

## What Happens

1. Lead lands in `website_leads`
2. Lead gets scored `hot / warm / cold`
3. Telegram alert fires
4. HTML + text reply draft is written to `C:/gsb-100/data/lead-drafts`
5. Follow-up reminders trigger on a timer if the lead still needs attention
