// Backorder Weekly Sweep
//
// Runs Sunday night. Finds orders tagged dhg-status-backorder (manually
// placed there after a direct conversation with the customer, per
// isManuallyBackordered() in process-orders.js) and re-checks whether each
// line item is now available - at any supplier via the same decision tree
// the Supplier Order Aggregation tool uses, OR already sitting in a bin.
//
// These orders are often well past the 30-day window the Monday aggregation
// scan covers, so this sweep can't just wait for Monday to pick them up
// naturally. Instead: anything found newly available gets written to a
// "Newly Available Backorders" tab that Monday's aggregation tool reads IN
// ADDITION to its normal scan, and the order's dhg-status tag flips from
// backorder to order-supplier so it re-enters normal automated processing
// (process-orders.js will then handle inventory-queued promotion / emails
// for it like any other order-supplier order).
//
// A backorder only clears once EVERY line item on it is available somewhere
// - a partially-available backorder stays tagged backorder and isn't
// reported, since flipping the order's status early would let
// process-orders.js treat it as fully actionable when it isn't.

import jwt from 'jsonwebtoken';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const BIN_TRACKER_URL = 'https://dhg-bin-tracker-app.vercel.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'hello@detectivehawkgames.com';
const FROM_NAME = 'Detective Hawk Games';
const NOTIFY_EMAIL = 'iain@detectivehawkgames.com';

const SKUS_SHEET_ID = '1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI';
const AGG_SHEET_ID = '1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE';
const BACKORDER_TAB = 'Newly Available Backorders';

const GOOGLE_SA_EMAIL_VAR = () => process.env.GOOGLE_SA_EMAIL;
const GOOGLE_SA_PRIVATE_KEY_VAR = () => {
  const raw = process.env.GOOGLE_SA_PRIVATE_KEY_B64 || process.env.GOOGLE_SA_PRIVATE_KEY || '';
  if (process.env.GOOGLE_SA_PRIVATE_KEY_B64) return Buffer.from(raw, 'base64').toString('utf8');
  return raw.replace(/\\n/g, '\n');
};

// ── Shopify auth ─────────────────────────────────────────────────────────────
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
  if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

async function getBackorderedOrders() {
  let orders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(`
      query getOrders($cursor: String) {
        orders(first: 50, after: $cursor, query: "tag:'dhg-status-backorder' fulfillment_status:unfulfilled") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              tags
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    sku
                    product { id }
                  }
                }
              }
            }
          }
        }
      }
    `, { cursor });

    orders = orders.concat(data.orders.edges.map(e => e.node));
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;
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

// ── Google Sheets auth + access ─────────────────────────────────────────────
async function getGoogleToken() {
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

async function sheetsGet(spreadsheetId, range) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets GET failed: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

async function sheetsPut(spreadsheetId, range, values) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`Sheets PUT failed: ${res.status} ${await res.text()}`);
}

async function sheetsClear(spreadsheetId, range) {
  const token = await getGoogleToken();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets clear failed: ${res.status}`);
}

async function ensureBackorderTabExists() {
  const token = await getGoogleToken();
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}?fields=sheets.properties.title`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  const titles = meta.sheets.map(s => s.properties.title);
  if (titles.includes(BACKORDER_TAB)) return;

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: BACKORDER_TAB } } }] }),
    }
  );
}

// ── Supplier lookup data (same decision tree as Supplier Order Aggregation) ──
function rowsToObjects(rows) {
  const [header, ...rest] = rows;
  return rest.map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

async function loadSupplierData() {
  const sheet1Rows = await sheetsGet(SKUS_SHEET_ID, 'Sheet1!A1:F');
  const sheet1 = rowsToObjects(sheet1Rows);
  const bySku = new Map();
  for (const row of sheet1) {
    const sku = row['Variant SKU']?.trim();
    if (sku) bySku.set(sku, row);
  }

  // Same drift as aggregate-supplier-orders.js: Cowork migrated these tabs
  // to plain "Asmodee"/"Alliance" names - detect header rows dynamically.
  const asmodeeRaw = await sheetsGet(SKUS_SHEET_ID, "'Asmodee'!A1:J20");
  const asmodeeHeaderRowIdx = asmodeeRaw.findIndex(row => row[0] === 'Code');
  if (asmodeeHeaderRowIdx === -1) {
    throw new Error('Could not find Asmodee tab header row');
  }
  const asmodeeAllRows = await sheetsGet(SKUS_SHEET_ID, `'Asmodee'!A${asmodeeHeaderRowIdx + 1}:J`);
  const asmodeeHeader = asmodeeAllRows[0];
  const asmodeeData = rowsToObjects([asmodeeHeader, ...asmodeeAllRows.slice(1)]);
  const asmodeeByCode = new Map();
  for (const row of asmodeeData) {
    const code = row['Code']?.trim();
    if (code) asmodeeByCode.set(code, row);
  }

  const udRaw = await sheetsGet(SKUS_SHEET_ID, "'Alliance'!A1:N20");
  const udHeaderRowIdx = udRaw.findIndex(row => row[0] === 'Category Name');
  if (udHeaderRowIdx === -1) {
    throw new Error('Could not find Alliance tab header row');
  }
  const udAllRows = await sheetsGet(SKUS_SHEET_ID, `'Alliance'!A${udHeaderRowIdx + 1}:N`);
  const udHeader = udAllRows[0];
  const udData = rowsToObjects([udHeader, ...udAllRows.slice(1)]);
  let universalByVendorItem = new Map();
  for (const row of udData) {
    const vendorItem = row['Vendor Item No.']?.trim();
    if (vendorItem) universalByVendorItem.set(vendorItem, row);
  }

  // Garland (ACDD): header row position isn't stable - see same fix in
  // aggregate-supplier-orders.js. Detect it instead of hardcoding a row.
  const garlandRaw = await sheetsGet(SKUS_SHEET_ID, 'Garland!A1:H20');
  const garlandHeaderRowIdx = garlandRaw.findIndex(row => row[0] === 'ItemID');
  if (garlandHeaderRowIdx === -1) {
    throw new Error('Could not find Garland tab header row (looked for "ItemID" in column A within the first 20 rows)');
  }
  const garlandAllRows = await sheetsGet(SKUS_SHEET_ID, `Garland!A${garlandHeaderRowIdx + 1}:H`);
  const garlandHeader = garlandAllRows[0];
  const garlandData = rowsToObjects([garlandHeader, ...garlandAllRows.slice(1)]);
  const garlandByItemId = new Map();
  for (const row of garlandData) {
    const itemId = row['ItemID']?.trim();
    if (itemId) garlandByItemId.set(itemId, row);
  }

  return { bySku, asmodeeByCode, universalByVendorItem, garlandByItemId };
}

const ASMODEE_UNAVAILABLE = new Set(['Out of Stock']);

function decideSupplier(sku, sheetData) {
  const skuRow = sheetData.bySku.get(sku);
  const tags = (skuRow?.['Tags'] || '').toLowerCase();
  const acddSku = skuRow?.['ACDD SKU']?.trim();

  const hasAsmodee = tags.includes('asmodee');
  const hasAlliance = tags.includes('alliance');

  function tryAcdd(reason) {
    if (!acddSku || acddSku === '#N/A') {
      return { supplier: null, reason: `${reason}; no ACDD SKU mapped` };
    }
    const garlandRow = sheetData.garlandByItemId.get(acddSku);
    if (garlandRow) return { supplier: 'acdd', acddSku, reason };
    return { supplier: null, reason: `${reason}; not found at ACDD either` };
  }

  if (hasAsmodee) {
    const asmodeeRow = sheetData.asmodeeByCode.get(sku);
    if (!asmodeeRow) return tryAcdd('Not found in Asmodee catalog');
    const status = asmodeeRow['Stock Status'];
    if (ASMODEE_UNAVAILABLE.has(status)) return tryAcdd(`Asmodee: ${status}`);
    return { supplier: 'asmodee' };
  }

  if (hasAlliance) {
    const udRow = sheetData.universalByVendorItem.get(sku);
    if (!udRow) return tryAcdd('Not found at any Universal Dist warehouse');
    const warehouses = ['RDL', 'FWA', 'AUS', 'VIS'];
    for (const wh of warehouses) {
      if (udRow[wh]?.trim().toLowerCase() === 'yes') return { supplier: 'universal_dist', warehouse: wh };
    }
    return tryAcdd('Out of stock at all Universal Dist warehouses');
  }

  return { supplier: null, reason: 'No Asmodee or Alliance tag found' };
}

// ── Bin tracker check ────────────────────────────────────────────────────────
async function getBinQuantities() {
  const res = await fetch(`${BIN_TRACKER_URL}/api/bins`);
  if (!res.ok) throw new Error(`Bin tracker fetch failed: ${res.status}`);
  const data = await res.json();
  const bins = data.bins || data;
  const totals = new Map();
  for (const items of Object.values(bins)) {
    for (const item of items) {
      totals.set(item.productId, (totals.get(item.productId) || 0) + item.quantity);
    }
  }
  return totals;
}

// ── Email digest ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendViaResend(payload) {
  await sleep(550);
  let res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
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

async function sendDigest(resolvedOrders) {
  if (!resolvedOrders.length) return;

  let html = `<h2>${resolvedOrders.length} backordered order(s) now have availability</h2>`;
  html += `<p>Re-tagged from backorder to order-supplier and added to the "Newly Available Backorders" tab for Monday's supplier aggregation.</p><ul>`;
  for (const o of resolvedOrders) {
    const itemsStr = o.items.map(i => `${i.title} (${i.sku}) x${i.quantity} - ${i.supplierLabel}`).join('; ');
    html += `<li><strong>${o.orderName}</strong>: ${itemsStr}</li>`;
  }
  html += `</ul>`;

  try {
    await sendViaResend({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [NOTIFY_EMAIL],
      subject: `${resolvedOrders.length} backordered order(s) now available - Backorder Sweep`,
      html,
    });
  } catch (err) {
    console.error('Backorder digest email FAILED to send:', err.message);
  }
}

function supplierLabel(decision, inBins) {
  if (inBins) return 'In Bins';
  if (decision.supplier === 'asmodee') return 'Asmodee';
  if (decision.supplier === 'universal_dist') return `Universal Dist (${decision.warehouse})`;
  if (decision.supplier === 'acdd') return 'ACDD';
  return 'Unavailable';
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [orders, sheetData, binQuantities] = await Promise.all([
      getBackorderedOrders(),
      loadSupplierData(),
      getBinQuantities(),
    ]);

    const resolvedOrders = [];
    const stillBackordered = [];
    const newlyAvailableRows = []; // for the sheet tab: Order, SKU, Qty, Title, Supplier

    for (const order of orders) {
      const lineResults = [];
      let allAvailable = true;

      for (const edge of order.lineItems.edges) {
        const item = edge.node;
        const sku = item.sku?.trim();
        if (!sku) { allAvailable = false; continue; }

        const productId = item.product?.id;
        const binQty = productId ? (binQuantities.get(productId) || 0) : 0;
        const inBins = binQty >= item.quantity;

        const decision = inBins ? { supplier: 'bins' } : decideSupplier(sku, sheetData);
        const available = inBins || decision.supplier != null;

        if (!available) allAvailable = false;

        lineResults.push({
          sku, title: item.title, quantity: item.quantity,
          supplierLabel: supplierLabel(decision, inBins),
          decision, inBins,
        });
      }

      if (allAvailable && lineResults.length) {
        resolvedOrders.push({ orderName: order.name, orderId: order.id, tags: order.tags, items: lineResults });
        for (const li of lineResults) {
          if (!li.inBins) {
            // Only items actually needing a supplier order go to the tab -
            // bin-covered items don't need ordering, just packing.
            newlyAvailableRows.push([order.name, li.sku, li.quantity, li.title, li.supplierLabel]);
          }
        }
      } else {
        stillBackordered.push(order.name);
      }
    }

    // Re-tag resolved orders so they re-enter normal automated processing
    for (const o of resolvedOrders) {
      await tagOrder(o.orderId, 'order-supplier', o.tags);
    }

    // Append (not overwrite) to Newly Available Backorders - Monday's
    // aggregation tool clears it after consuming, but if this sweep ever
    // runs twice before Monday for any reason, appending avoids losing
    // anything that hasn't been picked up yet.
    if (newlyAvailableRows.length) {
      await ensureBackorderTabExists();
      const existing = await sheetsGet(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E1000`).catch(() => []);
      const combined = [...existing.filter(r => r.length), ...newlyAvailableRows];
      await sheetsClear(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A1:E1000`);
      await sheetsPut(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A1:E1`, [['Order', 'SKU', 'Quantity', 'Title', 'Supplier']]);
      await sheetsPut(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E${combined.length + 1}`, combined);
    }

    await sendDigest(resolvedOrders);

    return res.status(200).json({
      success: true,
      backorderedOrdersChecked: orders.length,
      resolvedCount: resolvedOrders.length,
      resolvedOrders: resolvedOrders.map(o => o.orderName),
      stillBackorderedCount: stillBackordered.length,
      stillBackordered,
    });

  } catch (err) {
    console.error('Backorder sweep failed:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
