// ONE-TIME backfill script. Run once, manually, before the reworked process-orders
// cron goes live for real. Does two things:
//
// 1. For every unfulfilled order that ALREADY has a dhg-status-* tag (any age),
//    backfill Email History with that current status - since under the old cron,
//    an order only ever got tagged at the same moment its email was sent, so the
//    tag's mere presence is a reliable proxy for "email already sent."
//
// 2. For unfulfilled orders OLDER than 30 days that have NO dhg-status-* tag at all
//    (the stuck backlog), force-tag them order-supplier and backfill history for
//    that status too - WITHOUT sending any real email for this cleanup.
//
// Safe to re-run: it's idempotent (re-backfilling the same data twice is harmless),
// but it's intended as a single one-time pass before cutover, not a recurring job.

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const AGG_SHEET_ID = '1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE';
const EMAIL_HISTORY_RANGE = "'Email History'!A2:B1000";

const GOOGLE_SA_EMAIL_VAR = () => process.env.GOOGLE_SA_EMAIL;
const GOOGLE_SA_PRIVATE_KEY_VAR = () => {
  const raw = process.env.GOOGLE_SA_PRIVATE_KEY_B64 || process.env.GOOGLE_SA_PRIVATE_KEY || '';
  if (process.env.GOOGLE_SA_PRIVATE_KEY_B64) {
    return Buffer.from(raw, 'base64').toString('utf8');
  }
  return raw.replace(/\\n/g, '\n');
};

let _token = null;
let _tokenExpiresAt = 0;

async function getShopifyToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token = access_token;
  _tokenExpiresAt = Date.now() + expires_in * 1000;
  return _token;
}

async function graphql(query, variables = {}) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

async function getAllUnfulfilledOrders() {
  let orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(`
      query getOrders($query: String!, $cursor: String) {
        orders(first: 50, query: $query, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name tags createdAt } }
        }
      }
    `, { query: 'fulfillment_status:unfulfilled', cursor });

    const page = data.orders;
    orders = orders.concat(page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return orders;
}

async function tagOrder(orderId, status, existingTags) {
  const filtered = existingTags.filter(t => !t.startsWith('dhg-status-'));
  const newTags = [...filtered, `dhg-status-${status}`];
  await graphql(`
    mutation updateTags($id: ID!, $tags: [String!]!) {
      orderUpdate(input: { id: $id, tags: $tags }) {
        order { id }
        userErrors { field message }
      }
    }
  `, { id: orderId, tags: newTags });
}

// ── Google Sheets ────────────────────────────────────────────────────────────
async function getGoogleToken() {
  const jwtModule = await import('jsonwebtoken');
  const jwt = jwtModule.default;
  const token = jwt.sign(
    { scope: 'https://www.googleapis.com/auth/spreadsheets' },
    GOOGLE_SA_PRIVATE_KEY_VAR(),
    {
      algorithm: 'RS256',
      issuer: GOOGLE_SA_EMAIL_VAR(),
      audience: 'https://oauth2.googleapis.com/token',
      expiresIn: '1h',
    }
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

async function sheetsPut(range, values) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`Sheets PUT failed: ${res.status} ${await res.text()}`);
}

async function sheetsClear(range) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets clear failed: ${res.status}`);
}

const EARLY_STAGE_STATUSES = new Set([
  'order-placed', 'store-first-order', 'shop-first-order', 'preorder', 'order-delayed',
]);

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query.dryRun === '1';

  try {
    const orders = await getAllUnfulfilledOrders();
    const now = Date.now();

    const history = new Map(); // orderName -> Set of statuses
    const backlogTagged = [];
    const alreadyTaggedBackfilled = [];
    const leftAlone = []; // old orders already past early-stage, untouched
    const skippedBackorder = []; // manually backordered - never touched by automation

    for (const order of orders) {
      const currentTag = order.tags.find(t => t.startsWith('dhg-status-'));
      const currentStatus = currentTag ? currentTag.replace('dhg-status-', '') : null;
      const ageMs = now - new Date(order.createdAt).getTime();
      const isOld = ageMs > THIRTY_DAYS_MS;

      if (currentStatus === 'backorder') {
        // Manually backordered after a direct customer conversation - completely
        // off-limits to automation. Not backfilled into history, not touched.
        skippedBackorder.push(order.name);
        continue;
      }

      if (currentStatus) {
        // Case 1: already tagged (any age) - backfill history with its current status
        history.set(order.name, new Set([currentStatus]));
        alreadyTaggedBackfilled.push({ order: order.name, status: currentStatus });
      } else if (isOld) {
        // Case 2: untagged AND older than 30 days - force to order-supplier
        if (!dryRun) {
          await tagOrder(order.id, 'order-supplier', order.tags);
        }
        history.set(order.name, new Set(['order-supplier']));
        backlogTagged.push({ order: order.name, createdAt: order.createdAt });
      } else {
        // Untagged but recent (within 30 days) - leave alone, the new cron will
        // pick it up naturally on its next run and decide its first status.
        leftAlone.push(order.name);
      }
    }

    if (!dryRun) {
      const rows = [...history.entries()].map(([name, statuses]) => [name, [...statuses].join(', ')]);
      await sheetsClear(EMAIL_HISTORY_RANGE);
      if (rows.length) await sheetsPut(`'Email History'!A2:B${rows.length + 1}`, rows);
    }

    return res.status(200).json({
      dryRun,
      totalUnfulfilledOrders: orders.length,
      alreadyTaggedBackfilled: alreadyTaggedBackfilled.length,
      backlogTaggedOrderSupplier: backlogTagged.length,
      leftAloneUntaggedRecent: leftAlone.length,
      skippedBackorder: skippedBackorder.length,
      details: { alreadyTaggedBackfilled, backlogTagged, leftAlone, skippedBackorder },
    });

  } catch (err) {
    console.error('Backfill failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
