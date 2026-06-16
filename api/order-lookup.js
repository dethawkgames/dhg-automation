// Inline all dependencies to avoid module resolution issues in Vercel

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';

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
  if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token = access_token;
  _tokenExpiresAt = Date.now() + expires_in * 1000;
  return _token;
}

async function graphql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

const STATUS_LABELS = {
  'order-placed': { label: 'Order Placed', description: "We've received your order and are processing it." },
  'store-first-order': { label: 'Order Placed', description: "Welcome! We've received your first order and are processing it." },
  'shop-first-order': { label: 'Order Placed', description: "Welcome! We've received your first order and are processing it." },
  'preorder': { label: 'Pre-Order', description: "Your order contains a pre-order item. We'll ship everything together once all items are available." },
  'order-supplier': { label: 'Ordered from Supplier', description: "We've ordered your items from our supplier. They typically arrive by Thursday." },
  'shipped-from-supplier': { label: 'Shipped from Supplier', description: 'Your items are on their way to us from our supplier.' },
  'order-received': { label: 'Received at DHG', description: "Your items have arrived at our store! We'll be packing your order shortly." },
  'inventory-queued': { label: 'Packing Soon', description: "Your items have been pulled from our inventory and your order is queued for packing." },
  'order-delayed': { label: 'Slight Delay', description: "There's been a small delay with your order. We've reached out to our supplier and will update you soon." },
  'backorder': { label: 'Backordered', description: "Your item is currently on backorder. We'll notify you as soon as it becomes available." },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { orderNumber, email } = req.body || {};
  if (!orderNumber || !email) {
    return res.status(400).json({ error: 'Order number and email are required.' });
  }

  try {
    const cleanOrderNumber = orderNumber.replace('#', '').trim();
    const data = await graphql(`
      query findOrder($query: String!) {
        orders(first: 5, query: $query) {
          edges {
            node {
              id
              name
              email
              tags
              createdAt
              displayFinancialStatus
              lineItems(first: 20) {
                edges { node { title quantity } }
              }
            }
          }
        }
      }
    `, { query: `name:#${cleanOrderNumber}` });

    const orders = data.orders.edges.map(e => e.node);
    const order = orders.find(o => o.email?.toLowerCase() === email.toLowerCase().trim());

    if (!order) {
      return res.status(404).json({ error: 'No order found with that order number and email combination.' });
    }

    const statusTag = order.tags.find(t => t.startsWith('dhg-status-'));
    const statusKey = statusTag ? statusTag.replace('dhg-status-', '') : null;
    const statusInfo = statusKey ? STATUS_LABELS[statusKey] : null;

    return res.status(200).json({
      orderNumber: order.name,
      createdAt: order.createdAt,
      paymentStatus: order.displayFinancialStatus,
      status: statusInfo ? statusInfo.label : 'Processing',
      statusDescription: statusInfo ? statusInfo.description : 'Your order is being processed.',
      items: order.lineItems.edges.map(e => ({ title: e.node.title, quantity: e.node.quantity })),
    });

  } catch (err) {
    console.error('Order lookup error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
