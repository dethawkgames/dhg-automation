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

// Add a tag to a Shopify order
async function addOrderTag(orderId, tag) {
  const order = await graphql(`
    query getOrderTags($id: ID!) {
      order(id: $id) { id tags }
    }
  `, { id: orderId });

  const existing = order.order.tags || [];
  // Remove any existing dhg-status tags first
  const filtered = existing.filter(t => !t.startsWith('dhg-status-'));
  const newTags = [...filtered, `dhg-status-${tag}`];

  await graphql(`
    mutation updateOrderTags($id: ID!, $tags: [String!]!) {
      orderUpdate(input: { id: $id, tags: $tags }) {
        order { id tags }
        userErrors { field message }
      }
    }
  `, { id: orderId, tags: newTags });
}

// Get orders placed since a given date that don't have a dhg-status tag yet
async function getUntaggedOrders(sinceDate) {
  const query = `
    query getOrders($query: String!, $cursor: String) {
      orders(first: 50, query: $query, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            email
            tags
            createdAt
            channelInformation { channelDefinition { handle } }
            customer {
              id
              numberOfOrders
              email
              firstName
              lastName
              orders(first: 50) {
                edges {
                  node {
                    id
                    fulfillmentStatus
                  }
                }
              }
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  product {
                    id
                    title
                    metafield(namespace: "custom", key: "release_date") {
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const sinceStr = sinceDate.toISOString().split('T')[0];
  const searchQuery = `created_at:>=${sinceStr}`;

  let orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(query, { query: searchQuery, cursor });
    const page = data.orders;
    orders = orders.concat(page.edges.map(e => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  // Filter to only orders without a dhg-status tag
  return orders.filter(o => !o.tags.some(t => t.startsWith('dhg-status-')));
}

module.exports = { getToken, graphql, addOrderTag, getUntaggedOrders };
