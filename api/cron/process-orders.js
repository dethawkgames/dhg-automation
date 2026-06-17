// Self-contained cron handler - all dependencies inlined

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'hello@detectivehawkgames.com';
const FROM_NAME = 'Detective Hawk Games';
const ORDER_LOOKUP_URL = 'https://detectivehawkgames.com/pages/order-lookup';
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

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

// ── Fetch untagged orders ──────────────────────────────────────────────────
async function getUntaggedOrders() {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
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
                id firstName numberOfOrders
                orders(first: 50) {
                  edges { node { id displayFulfillmentStatus } }
                }
              }
              lineItems(first: 50) {
                edges {
                  node {
                    title quantity
                    product {
                      metafield(namespace: "custom", key: "release_date") { value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { query: `created_at:>=${sinceStr}`, cursor });

    const page = data.orders;
    orders = orders.concat(page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return orders.filter(o => !o.tags.some(t => t.startsWith('dhg-status-')));
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

function determineStatus(order) {
  if (hasPreorderItem(order)) return { status: 'preorder', sendEmail: true };
  if (isFirstTimeCustomer(order)) {
    const isShop = order.channelInformation?.channelDefinition?.handle === 'shop';
    return { status: isShop ? 'shop-first-order' : 'store-first-order', sendEmail: true };
  }
  return { status: 'order-placed', sendEmail: false };
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

async function sendEmail(status, { email, firstName, orderNumber }) {
  if (!EMAIL_STATUSES.has(status) || !email) return { skipped: true };
  const template = getEmailTemplate(status, { firstName, orderNumber });
  if (!template) return { skipped: true };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [email], subject: template.subject, html: template.html }),
  });

  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`DHG cron triggered at ${new Date().toISOString()}`);
    const orders = await getUntaggedOrders();
    console.log(`Found ${orders.length} untagged orders`);

    const results = [];
    for (const order of orders) {
      try {
        const { status, sendEmail: shouldEmail } = determineStatus(order);
        await tagOrder(order.id, status, order.tags);

        let emailResult = { skipped: true };
        if (shouldEmail && order.email) {
          emailResult = await sendEmail(status, {
            email: order.email,
            firstName: order.customer?.firstName || '',
            orderNumber: order.name,
          });
        }

        console.log(`${order.name} → dhg-status-${status} | email: ${!emailResult.skipped}`);
        results.push({ order: order.name, status, emailSent: !emailResult.skipped, success: true });
      } catch (err) {
        console.error(`Error on ${order.name}:`, err.message);
        results.push({ order: order.name, error: err.message, success: false });
      }
    }

    return res.status(200).json({
      message: `Processed ${results.length} orders.`,
      results,
    });

  } catch (err) {
    console.error('Cron failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
