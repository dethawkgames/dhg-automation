/**
 * revert-expired-preorder-templates.js
 *
 * Finds Shopify products (added in the last 6 months) that are:
 *   - tagged "preorder"
 *   - carry a "release-date-YYYY-MM-DD" tag that has already passed
 *   - still assigned to the "preorder" theme template (templateSuffix)
 * and reverts their theme template back to the default (templateSuffix: null).
 *
 * Usage:
 *   SHOPIFY_STORE=your-store.myshopify.com \
 *   SHOPIFY_CLIENT_ID=xxx \
 *   SHOPIFY_CLIENT_SECRET=xxx \
 *   node revert-expired-preorder-templates.js
 *
 *   ...same env vars... node revert-expired-preorder-templates.js --apply
 *
 * Default is a DRY RUN — it only prints what it would change.
 * Pass --apply to actually run the productUpdate mutations.
 *
 * Auth: this app provides a client ID + client secret rather than a plain
 * Admin API access token. The script exchanges those for a short-lived
 * access token via the OAuth client-credentials grant
 * (POST /admin/oauth/access_token) before making any Admin API calls.
 * The app still needs read_products + write_products scopes configured.
 *
 * Node 18+ (uses built-in fetch).
 */

const STORE = process.env.SHOPIFY_STORE;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const PREORDER_TEMPLATE_SUFFIX = 'preorder';
const APPLY = process.argv.includes('--apply');

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SHOPIFY_STORE, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET env vars.');
  process.exit(1);
}

const TOKEN_ENDPOINT = `https://${STORE}/admin/oauth/access_token`;
const ENDPOINT = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

let TOKEN = null; // populated by getAccessToken() before any GraphQL calls

async function getAccessToken() {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Token exchange succeeded but no access_token in response: ' + JSON.stringify(json));
  }
  return json.access_token;
}

function sixMonthsAgoISO() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error('GraphQL errors: ' + JSON.stringify(json.errors));
  }
  // Basic throttling backoff based on cost extensions, if present
  const throttle = json.extensions?.cost?.throttleStatus;
  if (throttle && throttle.currentlyAvailable < 200) {
    const waitMs = Math.ceil((200 - throttle.currentlyAvailable) / throttle.restoreRate) * 1000;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  }
  return json.data;
}

const PRODUCTS_QUERY = `
  query Products($cursor: String, $searchQuery: String!) {
    products(first: 50, after: $cursor, query: $searchQuery) {
      edges {
        node {
          id
          title
          tags
          createdAt
          templateSuffix
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation RevertTemplate($id: ID!) {
    productUpdate(input: { id: $id, templateSuffix: null }) {
      product {
        id
        templateSuffix
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function extractReleaseDate(tags) {
  const tag = tags.find((t) => /^release-date-\d{4}-\d{2}-\d{2}$/.test(t));
  if (!tag) return null;
  return tag.replace('release-date-', ''); // YYYY-MM-DD
}

async function fetchCandidateProducts() {
  const cutoff = sixMonthsAgoISO();
  const searchQuery = `tag:preorder AND created_at:>=${cutoff}`;
  const results = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor, searchQuery });
    for (const edge of data.products.edges) {
      results.push(edge.node);
    }
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return results;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will make changes)' : 'DRY RUN (no changes will be made)'}`);

  console.log('Exchanging client credentials for an access token...');
  TOKEN = await getAccessToken();
  console.log('Got access token.\n');

  console.log(`Scanning products tagged "preorder", created since ${sixMonthsAgoISO()}...\n`);

  const products = await fetchCandidateProducts();
  console.log(`Found ${products.length} candidate product(s).\n`);

  const today = new Date().toISOString().slice(0, 10);
  const toRevert = [];
  const noReleaseDateTag = [];
  const notYetReleased = [];
  const alreadyDefault = [];

  for (const p of products) {
    const releaseDate = extractReleaseDate(p.tags);

    if (!releaseDate) {
      noReleaseDateTag.push(p);
      continue;
    }

    const hasPassed = releaseDate < today;
    const onPreorderTemplate = p.templateSuffix === PREORDER_TEMPLATE_SUFFIX;

    if (!hasPassed) {
      notYetReleased.push({ ...p, releaseDate });
      continue;
    }

    if (!onPreorderTemplate) {
      alreadyDefault.push({ ...p, releaseDate });
      continue;
    }

    toRevert.push({ ...p, releaseDate });
  }

  console.log(`--- Products to revert to default template (${toRevert.length}) ---`);
  for (const p of toRevert) {
    console.log(`  ${p.title} — released ${p.releaseDate} — currently: ${p.templateSuffix}`);
  }

  console.log(`\n--- Already on default template, release passed (${alreadyDefault.length}) ---`);
  for (const p of alreadyDefault) {
    console.log(`  ${p.title} — released ${p.releaseDate} — template: ${p.templateSuffix || '(default)'}`);
  }

  console.log(`\n--- Not yet released, left alone (${notYetReleased.length}) ---`);
  for (const p of notYetReleased) {
    console.log(`  ${p.title} — releases ${p.releaseDate}`);
  }

  console.log(`\n--- Tagged preorder but missing a release-date-* tag, skipped (${noReleaseDateTag.length}) ---`);
  for (const p of noReleaseDateTag) {
    console.log(`  ${p.title} (id: ${p.id})`);
  }

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to revert the ${toRevert.length} product(s) listed above.`);
    return;
  }

  console.log(`\nApplying changes to ${toRevert.length} product(s)...`);
  for (const p of toRevert) {
    try {
      const data = await shopifyGraphQL(UPDATE_MUTATION, { id: p.id });
      const errors = data.productUpdate.userErrors;
      if (errors && errors.length) {
        console.error(`  FAILED: ${p.title} — ${JSON.stringify(errors)}`);
      } else {
        console.log(`  OK: ${p.title} — template now: ${data.productUpdate.product.templateSuffix || '(default)'}`);
      }
    } catch (err) {
      console.error(`  ERROR: ${p.title} — ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
