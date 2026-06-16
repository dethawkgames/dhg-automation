# DHG Automation

Order status automation for Detective Hawk Games. Runs twice daily (6am and noon ET) to tag Shopify orders with the correct DHG status and send customer emails via Resend.

## What it does

- Tags every new Shopify order with `dhg-status-{status}` based on:
  - Whether it contains a preorder item (release date > 2 weeks out)
  - Whether it's the customer's first-ever order
  - Which channel the order came from (Online Store vs Shop)
- Sends the appropriate customer email via Resend
- Provides an order lookup API for the DHG website

## Project structure

```
dhg-automation/
├── api/
│   ├── cron/
│   │   └── process-orders.js   # Cron endpoint (6am + noon ET)
│   └── order-lookup.js         # Order status lookup API
├── emails/
│   └── templates.js            # All 7 email templates
├── lib/
│   ├── shopify.js              # Shopify GraphQL client + token refresh
│   ├── status.js               # Status determination logic
│   ├── processor.js            # Main order processing loop
│   └── email.js                # Resend email sender
├── public/
│   └── order-lookup.html       # Embeddable order lookup page
├── vercel.json                 # Cron schedules
└── package.json
```

## Deployment

### 1. Create Vercel project

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy from project root
vercel
```

### 2. Set environment variables in Vercel dashboard

Go to your project → Settings → Environment Variables and add:

| Variable | Value |
| `SHOPIFY_CLIENT_ID` | your_client_id |
| `SHOPIFY_CLIENT_SECRET` | your_client_secret |
| `RESEND_API_KEY` | your_resend_api_key |
### 3. Deploy to production

```bash
vercel --prod
```

### 4. Verify cron is running

Check Vercel dashboard → your project → Cron Jobs. You should see two entries running at 11:00 UTC and 17:00 UTC (6am and noon ET).

### 5. Update order lookup page in Shopify

In `public/order-lookup.html`, update `API_URL` to your actual Vercel deployment URL, then embed the HTML into your Shopify `pages/order-lookup` page.

## Cron schedule

| Run | UTC | ET |
|---|---|---|
| Morning | 11:00 | 6:00 AM |
| Midday | 17:00 | 12:00 PM |

## Status flow

| Status | Email | Trigger |
|---|---|---|
| `preorder` | ✅ | Any line item has release date > 2 weeks out |
| `store-first-order` | ✅ | First ever order, Online Store channel |
| `shop-first-order` | ✅ | First ever order, Shop channel |
| `order-placed` | ❌ | Returning customer |
| `order-supplier` | ✅ | Set manually after Monday supplier orders |
| `shipped-from-supplier` | ❌ | Set manually when supplier charges card |
| `order-received` | ✅ | Set manually when shipment arrives at DHG |
| `inventory-queued` | ✅ | Set manually when all items confirmed in bins |
| `order-delayed` | ✅ | Set manually when supplier is running late |
| `backorder` | ❌ | Set manually after customer agrees to backorder |

## Cancelling W3 Order Status

Once this system is live and tested:
1. Verify 3-5 real orders have been processed correctly
2. Check that emails are arriving and look correct
3. Update the order lookup page in Shopify to point to the new API
4. Cancel the W3 Custom Order Status subscription
