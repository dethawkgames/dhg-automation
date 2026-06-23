// Self-contained cron handler - all dependencies inlined

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'hello@detectivehawkgames.com';
const FROM_NAME = 'Detective Hawk Games';
const ORDER_LOOKUP_URL = 'https://detectivehawkgames.com/pages/order-lookup';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTIFY_EMAIL = 'iain@detectivehawkgames.com';

async function generateThankYouCardCopy(firstName, lineItems) {
  const itemsList = lineItems.map(li => `${li.title} (x${li.quantity})`).join(', ');
  const prompt = `You are writing thank-you card copy for Detective Hawk Games, a board game store. A first-time customer named ${firstName} just had their order queued for shipping. Their order contains: ${itemsList}.

Write ONE punchy sentence (under 20 words) about their order, grouping items by theme/franchise where relevant (e.g. "Arkham Horror LCG", "Star Wars Imperial Assault"). Warm, genuine tone. You may mention specific product titles to help distinguish cards when customers share a first name. Do NOT include any greeting, "thank you", or sign-off - those are already printed on the card. Output ONLY the one sentence, nothing else.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error('Anthropic API error:', res.status, await res.text());
    return '(Could not generate card copy - write manually)';
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '(Could not generate card copy - write manually)';
}

async function sendInternalNotification(inventoryQueuedOrders, thankYouCards) {
  if (!inventoryQueuedOrders.length) return;

  let html = `<h2>Orders moved to Inventory Queued</h2><p>These orders had every item covered by current bin stock. Go pack them!</p><ul>`;
  for (const o of inventoryQueuedOrders) {
    html += `<li><strong>${o.orderNumber}</strong></li>`;
  }
  html += `</ul>`;

  if (thankYouCards.length) {
    html += `<h2>Thank-You Card Copy</h2><p>First-time shipments in this batch - here's the card copy to write:</p>`;
    for (const card of thankYouCards) {
      const nameLine = card.namesMatch
        ? `<strong>${card.recipientName}</strong>`
        : `<strong>${card.recipientName}</strong> (account holder: ${card.accountHolderName} - looks like a gift, address the card to ${card.recipientName})`;
      html += `<p>${nameLine} (Order ${card.orderNumber})<br>${card.copy}</p>`;
    }
  }

  try {
    await sendViaResend({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [NOTIFY_EMAIL],
      subject: `${inventoryQueuedOrders.length} order(s) ready to pack - Inventory Queued`,
      html,
    });
  } catch (err) {
    // This is the internal digest, not a customer email - if it fails, log it
    // loudly so the failure is visible in Vercel's function logs rather than
    // silently disappearing, since there's no other record of this attempt.
    console.error('Internal notification email FAILED to send:', err.message);
  }
}
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
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

// ── Google Sheets auth + access (for Email History tracking) ───────────────
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

async function sheetsGet(range) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets GET failed: ${res.status}`);
  const data = await res.json();
  return data.values || [];
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

// Loads the full Email History as a Map: orderName -> Set of statuses already emailed
async function loadEmailHistory() {
  const rows = await sheetsGet(EMAIL_HISTORY_RANGE);
  const history = new Map();
  for (const row of rows) {
    const orderName = row[0];
    if (!orderName) continue;
    const statuses = (row[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    history.set(orderName, new Set(statuses));
  }
  return history;
}

// Rewrites the entire Email History tab from the in-memory map.
// Safe because the cron loads the full history, mutates it, then writes it all back
// in one pass - no concurrent writers expected (single cron, no overlapping runs).
async function saveEmailHistory(history) {
  const rows = [...history.entries()]
    .filter(([, statuses]) => statuses.size > 0)
    .map(([orderName, statuses]) => [orderName, [...statuses].join(', ')]);
  await sheetsClear(EMAIL_HISTORY_RANGE);
  if (rows.length) await sheetsPut(`'Email History'!A2:B${rows.length + 1}`, rows);
}

// ── Shopify token ──────────────────────────────────────────────────────────
let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
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
  const token = await getToken();
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

// ── Fetch orders in scope: unfulfilled, created in the last 30 days ────────
async function getOrdersInScope() {
  const since = new Date(Date.now() - THIRTY_DAYS_MS);
  const sinceStr = since.toISOString().split('T')[0];

  let orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(`
      query getOrders($query: String!, $cursor: String) {
        orders(first: 50, query: $query, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id name email tags createdAt
              channelInformation { channelDefinition { handle } }
              customer {
                id firstName lastName numberOfOrders
                orders(first: 50) {
                  edges { node { id displayFulfillmentStatus } }
                }
              }
              shippingAddress { firstName lastName }
              lineItems(first: 50) {
                edges {
                  node {
                    title quantity
                    product {
                      id
                      metafield(namespace: "custom", key: "release_date") { value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { query: `fulfillment_status:unfulfilled created_at:>=${sinceStr}`, cursor });

    const page = data.orders;
    orders = orders.concat(page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return orders;
}

function currentDhgStatus(order) {
  const tag = order.tags.find(t => t.startsWith('dhg-status-'));
  return tag ? tag.replace('dhg-status-', '') : null;
}

// Orders manually placed on backorder (after a direct conversation with the
// customer) are off-limits to all automated processing - no status changes,
// no inventory-queued promotion, no emails. They opt back in only when a
// human manually changes the tag.
function isManuallyBackordered(order) {
  return order.tags.some(t => t === 'dhg-status-backorder');
}

// ── Tag order ──────────────────────────────────────────────────────────────
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

// ── Status logic ───────────────────────────────────────────────────────────
function hasPreorderItem(order) {
  for (const edge of order.lineItems.edges) {
    const val = edge.node.product?.metafield?.value;
    if (val) {
      const d = new Date(val);
      if (!isNaN(d) && d - Date.now() > TWO_WEEKS_MS) return true;
    }
  }
  return false;
}

function isFirstTimeCustomer(order) {
  if (!order.customer) return true;
  return parseInt(order.customer.numberOfOrders, 10) <= 1;
}

function isFirstShipment(order) {
  if (!order.customer) return true;
  return !order.customer.orders.edges.some(
    e => e.node.id !== order.id && e.node.displayFulfillmentStatus === "FULFILLED"
  );
}

// ── Bin tracker check ────────────────────────────────────────────────────────
const BIN_TRACKER_URL = 'https://dhg-bin-tracker-app.vercel.app';

async function getBinQuantities() {
  const res = await fetch(`${BIN_TRACKER_URL}/api/bins`);
  if (!res.ok) throw new Error(`Bin tracker fetch failed: ${res.status}`);
  const data = await res.json();
  const bins = data.bins || data;

  // Aggregate total quantity per productId across all bins/shelf
  const totals = new Map();
  for (const items of Object.values(bins)) {
    for (const item of items) {
      totals.set(item.productId, (totals.get(item.productId) || 0) + item.quantity);
    }
  }
  return totals;
}

// Checks if every line item's required quantity is covered by remaining bin stock.
// Does NOT mutate availableQty - caller decides whether to commit the deduction.
function allItemsCoveredByBins(order, availableQty) {
  for (const edge of order.lineItems.edges) {
    const item = edge.node;
    const productId = item.product?.id;
    if (!productId) return false;
    const have = availableQty.get(productId) || 0;
    if (have < item.quantity) return false;
  }
  return true;
}

// Deducts this order's line items from the running availability map (call only after confirming coverage)
function deductFromBins(order, availableQty) {
  for (const edge of order.lineItems.edges) {
    const item = edge.node;
    const productId = item.product?.id;
    availableQty.set(productId, (availableQty.get(productId) || 0) - item.quantity);
  }
}

// IMPORTANT: orders must be processed oldest-first so that when bin stock is limited,
// the order that's been waiting longest gets priority for inventory-queued status,
// not whichever order happens to come first in API pagination order.
function sortOldestFirst(orders) {
  return [...orders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// Decides the FIRST status for a brand-new (untagged) order. This is only
// ever called for orders that did NOT qualify for the inventory-queued
// shortcut, so inventory-queued is intentionally absent from this priority list.
function decideInitialStatus(order) {
  if (hasPreorderItem(order)) return 'preorder';
  if (isFirstTimeCustomer(order)) {
    const isShop = order.channelInformation?.channelDefinition?.handle === 'shop';
    return isShop ? 'shop-first-order' : 'store-first-order';
  }
  return 'order-placed';
}

// ── Email templates ────────────────────────────────────────────────────────
function baseTemplate(content) {
  const LOGO = 'https://detectivehawkgames.com/cdn/shop/files/Text_Logo_002_280x.png?v=1670109213';
  const ADDR = 'Detective Hawk Games, 109 Ambersweet Way, Davenport FL 33897';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif}
    .w{max-width:600px;margin:0 auto;background:#fff}
    .logo{text-align:center;padding:30px 20px 20px}
    .logo img{max-width:220px;height:auto}
    .c{padding:10px 40px 30px;color:#333;font-size:15px;line-height:1.6}
    h1{font-size:20px;font-weight:bold;margin-bottom:16px;color:#1a1a1a}
    p{margin:0 0 14px}
    .btn-teal{display:inline-block;background:#3aacb5;color:#fff!important;text-decoration:none;padding:10px 24px;border-radius:4px;font-size:14px;font-weight:bold}
    .btn-red{display:inline-block;background:#c0392b;color:#fff!important;text-decoration:none;padding:10px 24px;border-radius:4px;font-size:14px;font-weight:bold}
    .btn-wrap{text-align:center;margin:20px 0}
    .red{color:#c0392b;font-weight:bold}
    .notes{color:#c0392b;margin:14px 0}
    .footer{text-align:center;padding:16px;font-size:12px;color:#888;background:#f5f5f5}
  </style></head><body>
  <div class="w">
    <div class="logo"><img src="${LOGO}" alt="Detective Hawk Games"/></div>
    <div class="c">${content}</div>
  </div>
  <div class="footer">${ADDR}</div>
  </body></html>`;
}

function getEmailTemplate(status, { firstName, orderNumber } = {}) {
  const name = firstName || 'there';
  const order = orderNumber || '';

  switch (status) {
    case 'store-first-order': return {
      subject: 'Detective Hawk Games - First Order',
      html: baseTemplate(`
        <h1>Detective Hawk Games - First Order</h1>
        <p>Thanks for your order with Detective Hawk Games! We noticed that you ordered via our online store and this is your first time ordering. Welcome! We realize you may not be familiar with how our store works.</p>
        <p>We are a small family-run business, and we keep a limited number of games and items in our local inventory, for everything else we order in directly from the supplier every Monday. (In the case of a holiday - it will be the next business day)</p>
        <p>We identify which products fall into this category on our website. One or more of your items fall into this category and will need to be ordered in.</p>
        <p>We will place the order and our shipment will arrive later that week. It usually arrives on Thursdays.</p>
        <p>Our aim is to process your order within 24 hours. From time to time, our UPS delivery is delayed. We will notify you if that happens. You will also get an automated email from us both when we order your product and when it arrives here. We believe in being transparent. If you do prefer not to wait or this timeline does not work for you, please respond to this email and we will be more than happy to refund you.</p>
        <p>Feel free to let us know if you have any questions.</p>
        <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Status Lookup</a></div>
      `)
    };

    case 'shop-first-order': return {
      subject: 'Detective Hawk Games Shop First Order',
      html: baseTemplate(`
        <h1>Detective Hawk Games Shop First Order</h1>
        <p>Thanks for your order with Detective Hawk Games! We noticed that you ordered via the Shop app and this is your first time ordering. Welcome! We realize you may not be familiar with how our store works.</p>
        <p>We are a small family-run business, and we keep a limited number of games and items in our local inventory, for everything else we order in directly from the supplier every Monday. (Or the next business day when there is a holiday.)</p>
        <p>We identify which products fall into this category on our website and are actively working with Shopify to add this messaging to the Shop App. One or more of your items fall into this category and will need to be ordered in.</p>
        <p>We will place the order and our shipment will arrive later in the week. It usually arrives on Thursdays.</p>
        <p>Our aim is to process your order within 24 hours. From time to time, our UPS delivery is delayed. We will notify you if that happens. You will also get an automated email from us both when we order your product and when it arrives here. We believe in being transparent. If you do prefer not to wait or this timeline does not work for you, please respond to this email and we will be more than happy to refund you.</p>
        <p>Feel free to let us know if you have any questions. Again, we know this is a limitation of the Shop App and are working to correct it.</p>
        <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Status Lookup</a></div>
      `)
    };

    case 'order-supplier': return {
      subject: 'Detective Hawk Games Order Update',
      html: baseTemplate(`
        <h1>Detective Hawk Games Order Update</h1>
        <p>Hi ${name},</p>
        <p>We want to update you on your order. Your items have been ordered from our suppliers Asmodee and Universal Distribution.</p>
        <p>Some of your items may already be in stock here, if that's the case, rest assured we have set aside those items for you. The items we're getting in from the suppliers will take a few days to arrive here. Once they do, we'll get everything packed up and shipped out to you.</p>
        <p>You will get another email once we have received your items here.</p>
        <p>Let us know if you have any questions!</p>
        <p>Best,<br>Detective Hawk Games</p>
      `)
    };

    case 'order-received': return {
      subject: 'Detective Hawk Games Order Received',
      html: baseTemplate(`
        <h1>Detective Hawk Games Order Received</h1>
        <p>Hi ${name},</p>
        <p>Your items have been received at our store for <strong>Order # ${order}</strong>. Time to get excited!</p>
        <p>We hope to get everything out to you in the next day or so. We ask for some patience as we work through everyone's orders. If this email arrives to you on a Friday or over a weekend, we will be packing up your order over the weekend and either UPS or US Postal will pick it up on Monday. You will receive a shipping notice with tracking as soon as we have packed up your order and its ready to go out!</p>
        <p>Let us know if you have any questions!</p>
        <p>Detective Hawk Games</p>
        <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Lookup</a></div>
      `)
    };

    case 'inventory-queued': return {
      subject: 'Detective Hawk Games Order Update',
      html: baseTemplate(`
        <p>Hi ${name},</p>
        <p>Your items have been pulled from our inventory. Time to get excited! We hope to get everything out to you in the next day or so. If this email arrives to you on a Friday, we will be packing up your order over the weekend and either UPS or US Postal will pick it up on Monday. You will receive a shipping notice with tracking as soon as we have packed up your order and its ready to go out!</p>
        <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">View Order Details</a></div>
        <p>Let us know if you have any questions!</p>
        <p>Detective Hawk Games</p>
      `)
    };

    case 'preorder': return {
      subject: `Order # ${order} Update`,
      html: baseTemplate(`
        <h1>Order # ${order} Update</h1>
        <p>Hi ${name},</p>
        <p>Thanks for your order from Detective Hawk Games!</p>
        <p>We are currently reviewing all outstanding orders and your order includes preorders.</p>
        <p>Right now the release date for your product is listed on the product page on our website. It is subject to change and is at the discretion of the publisher. We have no control over publication dates.</p>
        <p>You will get another email once we have received your items from the supplier.</p>
        <p>We are a small family-run business and <span class="red">we do not ship partial orders</span>. If you have additional items in your order and would like them shipped ahead of the preorder, please contact us by responding to this email. We want to work with you to get your order to you in a timely fashion.</p>
        <p>For continued status updates, please use the Order Status link previously provided.</p>
        <p>Let us know if you have any questions!</p>
        <p>Detective Hawk Games</p>
      `)
    };

    case 'order-delayed': return {
      subject: 'DHG Order Update',
      html: baseTemplate(`
        <h1>DHG Order Update</h1>
        <p>Hi ${name},</p>
        <p>Thanks for your order with Detective Hawk Games!</p>
        <p>We want to update you on your order: ${order}</p>
        <p>Shipping from our suppliers was delayed. We ordered your items last Monday, and they have yet to be shipped to us.</p>
        <p>We've reached out to them to find out what is causing the delay. We will update your order as soon as we hear back.</p>
        <p>You will get another email once we have received the order here.</p>
        <p>Again, sorry for the delay and please reach out if you have questions or concerns.</p>
        <p>Best,<br>Iain<br>Owner, Detective Hawk Games</p>
        <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-red">Order Status Lookup</a></div>
      `)
    };

    default: return null;
  }
}

// ── Send email via Resend ──────────────────────────────────────────────────
const EMAIL_STATUSES = new Set(['store-first-order','shop-first-order','order-supplier','order-received','inventory-queued','preorder','order-delayed']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resend's default rate limit is 2 requests/second. A cron run can easily need
// to send several emails in the same pass (customer emails + the internal
// digest), so every call goes through this wrapper: a small delay before each
// send, and one retry with backoff if we still get rate-limited.
async function sendViaResend(payload) {
  await sleep(550); // keep us comfortably under 2 req/sec

  let res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    console.warn('Resend rate limit hit, retrying after backoff...');
    await sleep(1500);
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function sendEmail(status, { email, firstName, orderNumber }) {
  if (!EMAIL_STATUSES.has(status) || !email) return { skipped: true };
  const template = getEmailTemplate(status, { firstName, orderNumber });
  if (!template) return { skipped: true };

  return await sendViaResend({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: template.subject,
    html: template.html,
  });
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`DHG cron triggered at ${new Date().toISOString()}`);
    const dryRun = req.query.dryRun === '1';

    const orders = await getOrdersInScope();
    console.log(`Found ${orders.length} unfulfilled orders in the last 30 days`);

    // Oldest-first so limited bin stock goes to whoever's been waiting longest
    const sortedOrders = sortOldestFirst(orders);
    const availableQty = await getBinQuantities();
    const emailHistory = await loadEmailHistory();

    const results = [];
    const newlyInventoryQueued = [];
    const thankYouCards = [];

    for (const order of sortedOrders) {
      try {
        if (isManuallyBackordered(order)) {
          results.push({ order: order.name, status: 'backorder', skipped: true, reason: 'Manually backordered - excluded from automation', success: true });
          continue;
        }

        const current = currentDhgStatus(order);
        const alreadySent = emailHistory.get(order.name) || new Set();

        let newStatus = current;
        let isNewlyTagged = false;

        // Step 1: inventory-queued shortcut - checked for EVERY order, tagged or not.
        // If it qualifies, this skips the rest of the flow entirely for this order.
        if (allItemsCoveredByBins(order, availableQty)) {
          deductFromBins(order, availableQty);
          if (current !== 'inventory-queued') {
            newStatus = 'inventory-queued';
            isNewlyTagged = true;
            newlyInventoryQueued.push({ orderNumber: order.name });

            if (isFirstShipment(order)) {
              const lineItems = order.lineItems.edges.map(e => ({
                title: e.node.title,
                quantity: e.node.quantity,
              }));
              const accountHolderName = order.customer?.firstName || 'there';
              const shipFirst = order.shippingAddress?.firstName;
              const shipLast = order.shippingAddress?.lastName;
              const recipientName = shipFirst || accountHolderName;
              // Compare first+last together, not just first name, since two
              // different people can share a first name coincidentally.
              const namesMatch = !shipFirst ||
                (shipFirst === order.customer?.firstName && shipLast === order.customer?.lastName);

              const copy = await generateThankYouCardCopy(recipientName, lineItems);
              thankYouCards.push({
                accountHolderName,
                recipientName,
                namesMatch,
                orderNumber: order.name,
                copy,
              });
            }
          }
        } else if (!current) {
          // Step 2a: brand-new untagged order - decide its first status
          newStatus = decideInitialStatus(order);
          isNewlyTagged = true;
        }
        // Step 2b: already-tagged order, didn't qualify for inventory-queued -
        // newStatus stays equal to current; we just check email history below.

        if (isNewlyTagged && !dryRun) {
          await tagOrder(order.id, newStatus, order.tags);
        }

        let emailResult = { skipped: true };
        const needsEmail = newStatus && EMAIL_STATUSES.has(newStatus) && !alreadySent.has(newStatus);

        if (needsEmail && order.email && !dryRun) {
          emailResult = await sendEmail(newStatus, {
            email: order.email,
            firstName: order.customer?.firstName || '',
            orderNumber: order.name,
          });
          if (!emailResult.skipped) {
            alreadySent.add(newStatus);
            emailHistory.set(order.name, alreadySent);
          }
        } else if (needsEmail && dryRun) {
          // In dry-run, report what WOULD be sent without actually sending or recording it
          emailResult = { skipped: false, dryRun: true };
        }

        console.log(`${order.name}: ${current || '(none)'} → ${newStatus} | email sent: ${!emailResult.skipped}`);
        results.push({
          order: order.name,
          previousStatus: current,
          newStatus,
          newlyTagged: isNewlyTagged,
          emailSent: !emailResult.skipped,
          success: true,
        });
      } catch (err) {
        console.error(`Error on ${order.name}:`, err.message);
        results.push({ order: order.name, error: err.message, success: false });
      }
    }

    if (!dryRun) {
      await saveEmailHistory(emailHistory);
      await sendInternalNotification(newlyInventoryQueued, thankYouCards);
    }

    return res.status(200).json({
      message: `Processed ${results.length} orders.`,
      inventoryQueuedCount: newlyInventoryQueued.length,
      thankYouCardsGenerated: thankYouCards.length,
      thankYouCards: dryRun ? thankYouCards : undefined,
      results,
    });

  } catch (err) {
    console.error('Cron failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
