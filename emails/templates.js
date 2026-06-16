const LOGO_URL = 'https://detectivehawkgames.com/cdn/shop/files/DHG_Logo.png';
const ORDER_LOOKUP_URL = 'https://detectivehawkgames.com/pages/order-lookup';
const ADDRESS = 'Detective Hawk Games, 109 Ambersweet Way, Davenport FL 33897';

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #f5f5f5; font-family: Arial, sans-serif; }
    .wrapper { max-width: 600px; margin: 0 auto; background: #ffffff; }
    .logo-block { text-align: center; padding: 30px 20px 20px; }
    .logo-block img { max-width: 220px; height: auto; }
    .content { padding: 10px 40px 30px; color: #333333; font-size: 15px; line-height: 1.6; }
    .content h1 { font-size: 20px; font-weight: bold; margin-bottom: 16px; color: #1a1a1a; }
    .content p { margin: 0 0 14px; }
    .btn-teal { display: inline-block; background: #3aacb5; color: #ffffff !important; text-decoration: none; padding: 10px 24px; border-radius: 4px; font-size: 14px; font-weight: bold; margin: 10px 0; }
    .btn-red { display: inline-block; background: #c0392b; color: #ffffff !important; text-decoration: none; padding: 10px 24px; border-radius: 4px; font-size: 14px; font-weight: bold; margin: 10px 0; }
    .btn-wrap { text-align: center; margin: 20px 0; }
    .highlight-red { color: #c0392b; font-weight: bold; }
    .public-notes { color: #c0392b; margin: 14px 0; }
    .footer { text-align: center; padding: 16px; font-size: 12px; color: #888888; background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="logo-block">
      <img src="${LOGO_URL}" alt="Detective Hawk Games" />
    </div>
    <div class="content">
      ${content}
    </div>
  </div>
  <div class="footer">${ADDRESS}</div>
</body>
</html>`;
}

function storeFirstOrder({ publicNotes } = {}) {
  return {
    subject: 'Detective Hawk Games - First Order',
    html: baseTemplate(`
      <h1>Detective Hawk Games - First Order</h1>
      <p>Thanks for your order with Detective Hawk Games! We noticed that you ordered via our online store and this is your first time ordering. Welcome! We realize you may not be familiar with how our store works.</p>
      <p>We are a small family-run business, and we keep a limited number of games and items in our local inventory, for everything else we order in directly from the supplier every Monday. (In the case of a holiday - it will be the next business day)</p>
      <p>We identify which products fall into this category on our website. One or more of your items fall into this category and will need to be ordered in.</p>
      <p>We will place the order and our shipment will arrive later that week. It usually arrives on Thursdays.</p>
      <p>Our aim is to process your order within 24 hours. From time to time, our UPS delivery is delayed. We will notify you if that happens. You will also get an automated email from us both when we order your product and when it arrives here. We believe in being transparent. If you do prefer not to wait or this timeline does not work for you, please respond to this email and we will be more than happy to refund you.</p>
      <p>Feel free to let us know if you have any questions.</p>
      ${publicNotes ? `<p class="public-notes">${publicNotes}</p>` : ''}
      <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Status Lookup</a></div>
    `),
  };
}

function shopFirstOrder({ publicNotes } = {}) {
  return {
    subject: 'Detective Hawk Games Shop First Order',
    html: baseTemplate(`
      <h1>Detective Hawk Games Shop First Order</h1>
      <p>Thanks for your order with Detective Hawk Games! We noticed that you ordered via the Shop app and this is your first time ordering. Welcome! We realize you may not be familiar with how our store works.</p>
      <p>We are a small family-run business, and we keep a limited number of games and items in our local inventory, for everything else we order in directly from the supplier every Monday. (Or the next business day when there is a holiday.)</p>
      <p>We identify which products fall into this category on our website and are actively working with Shopify to add this messaging to the Shop App. One or more of your items fall into this category and will need to be ordered in.</p>
      <p>We will place the order and our shipment will arrive later in the week. It usually arrives on Thursdays.</p>
      <p>Our aim is to process your order within 24 hours. From time to time, our UPS delivery is delayed. We will notify you if that happens. You will also get an automated email from us both when we order your product and when it arrives here. We believe in being transparent. If you do prefer not to wait or this timeline does not work for you, please respond to this email and we will be more than happy to refund you.</p>
      <p>Feel free to let us know if you have any questions. Again, we know this is a limitation of the Shop App and are working to correct it.</p>
      ${publicNotes ? `<p class="public-notes">${publicNotes}</p>` : ''}
      <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Status Lookup</a></div>
    `),
  };
}

function orderSupplier({ firstName, publicNotes } = {}) {
  return {
    subject: 'Detective Hawk Games Order Update',
    html: baseTemplate(`
      <h1>Detective Hawk Games Order Update</h1>
      <p>Hi ${firstName || 'there'},</p>
      <p>We want to update you on your order. Your items have been ordered from our suppliers Asmodee and Universal Distribution.</p>
      <p>Some of your items may already be in stock here, if that's the case, rest assured we have set aside those items for you. The items we're getting in from the suppliers will take a few days to arrive here. Once they do, we'll get everything packed up and shipped out to you.</p>
      <p>You will get another email once we have received your items here.</p>
      <p>Let us know if you have any questions!</p>
      ${publicNotes ? `<p class="public-notes">${publicNotes}</p>` : ''}
      <p>Best,<br>Detective Hawk Games</p>
    `),
  };
}

function orderReceived({ firstName, orderNumber } = {}) {
  return {
    subject: `Detective Hawk Games Order Received`,
    html: baseTemplate(`
      <h1>Detective Hawk Games Order Received</h1>
      <p>Hi ${firstName || 'there'},</p>
      <p>Your items have been received at our store for <strong>Order # ${orderNumber}</strong>. Time to get excited!</p>
      <p>We hope to get everything out to you in the next day or so. We ask for some patience as we work through everyone's orders. If this email arrives to you on a Friday or over a weekend, we will be packing up your order over the weekend and either UPS or US Postal will pick it up on Monday. You will receive a shipping notice with tracking as soon as we have packed up your order and its ready to go out!</p>
      <p>Let us know if you have any questions!</p>
      <p>Detective Hawk Games</p>
      <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">Order Lookup</a></div>
    `),
  };
}

function inventoryQueued({ firstName } = {}) {
  return {
    subject: 'Detective Hawk Games Order Update',
    html: baseTemplate(`
      <p>Hi ${firstName || 'there'},</p>
      <p>Your items have been pulled from our inventory. Time to get excited! We hope to get everything out to you in the next day or so. If this email arrives to you on a Friday, we will be packing up your order over the weekend and either UPS or US Postal will pick it up on Monday. You will receive a shipping notice with tracking as soon as we have packed up your order and its ready to go out!</p>
      <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-teal">View Order Details</a></div>
      <p>Let us know if you have any questions!</p>
      <p>Detective Hawk Games</p>
    `),
  };
}

function preorder({ firstName, orderNumber, publicNotes } = {}) {
  return {
    subject: `Order # ${orderNumber} Update`,
    html: baseTemplate(`
      <h1>Order # ${orderNumber} Update</h1>
      <p>Hi ${firstName || 'there'},</p>
      <p>Thanks for your order from Detective Hawk Games!</p>
      <p>We are currently reviewing all outstanding orders and your order includes preorders.</p>
      <p>Right now the release date for your product is listed on the product page on our website. It is subject to change and is at the discretion of the publisher. We have no control over publication dates.</p>
      <p>You will get another email once we have received your items from the supplier.</p>
      <p>We are a small family-run business and <span class="highlight-red">we do not ship partial orders</span>. If you have additional items in your order and would like them shipped ahead of the preorder, please contact us by responding to this email. We want to work with you to get your order to you in a timely fashion.</p>
      <p>For continued status updates, please use the Order Status link previously provided.</p>
      <p>Let us know if you have any questions!</p>
      <p>Detective Hawk Games</p>
      ${publicNotes ? `<p class="public-notes">${publicNotes}</p>` : ''}
    `),
  };
}

function orderDelayed({ firstName, orderNumber } = {}) {
  return {
    subject: 'DHG Order Update',
    html: baseTemplate(`
      <h1>DHG Order Update</h1>
      <p>Hi ${firstName || 'there'},</p>
      <p>Thanks for your order with Detective Hawk Games!</p>
      <p>We want to update you on your order: ${orderNumber}</p>
      <p>Shipping from our suppliers was delayed. We ordered your items last Monday, and they have yet to be shipped to us.</p>
      <p>We've reached out to them to find out what is causing the delay. We will update your order as soon as we hear back.</p>
      <p>You will get another email once we have received the order here.</p>
      <p>Again, sorry for the delay and please reach out if you have questions or concerns.</p>
      <p>Best,<br>Iain<br>Owner, Detective Hawk Games</p>
      <div class="btn-wrap"><a href="${ORDER_LOOKUP_URL}" class="btn-red">Order Status Lookup</a></div>
    `),
  };
}

// Map status slug to template function
function getEmailTemplate(status, data) {
  switch (status) {
    case 'store-first-order': return storeFirstOrder(data);
    case 'shop-first-order': return shopFirstOrder(data);
    case 'order-supplier': return orderSupplier(data);
    case 'order-received': return orderReceived(data);
    case 'inventory-queued': return inventoryQueued(data);
    case 'preorder': return preorder(data);
    case 'order-delayed': return orderDelayed(data);
    default: return null;
  }
}

// Statuses that send email
const EMAIL_STATUSES = new Set([
  'store-first-order',
  'shop-first-order',
  'order-supplier',
  'order-received',
  'inventory-queued',
  'preorder',
  'order-delayed',
]);

module.exports = { getEmailTemplate, EMAIL_STATUSES };
