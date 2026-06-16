const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

// Check if any line item has a release date more than 2 weeks out
function hasPreorderItem(order) {
  for (const edge of order.lineItems.edges) {
    const item = edge.node;
    const releaseDateField = item.product?.metafield?.value;
    if (releaseDateField) {
      const releaseDate = new Date(releaseDateField);
      if (!isNaN(releaseDate) && releaseDate - Date.now() > TWO_WEEKS_MS) {
        return true;
      }
    }
  }
  return false;
}

// Check if customer has any prior orders (regardless of fulfillment)
function isFirstTimeCustomer(order) {
  const customer = order.customer;
  if (!customer) return true; // Guest checkout — treat as first time
  return parseInt(customer.numberOfOrders, 10) <= 1;
}

// Check if this is the customer's first SHIPMENT
// (has anything ever been fulfilled to them?)
function isFirstShipment(order) {
  const customer = order.customer;
  if (!customer) return true;
  const priorOrders = customer.orders.edges.map(e => e.node);
  const hasFulfilled = priorOrders.some(
    o => o.id !== order.id && o.fulfillmentStatus === 'FULFILLED'
  );
  return !hasFulfilled;
}

// Get the sales channel handle
function getChannel(order) {
  return order.channelInformation?.channelDefinition?.handle || 'online_store';
}

// Determine the correct DHG status for an order
function determineStatus(order) {
  // 1. Preorder check runs first — overrides everything
  if (hasPreorderItem(order)) {
    return {
      status: 'preorder',
      sendEmail: true,
      isFirstShipment: isFirstShipment(order),
    };
  }

  // 2. First time vs returning customer
  const firstTime = isFirstTimeCustomer(order);
  const channel = getChannel(order);

  if (firstTime) {
    // Distinguish between Online Store and Shop channel
    const isShopChannel = channel === 'shop';
    return {
      status: isShopChannel ? 'shop-first-order' : 'store-first-order',
      sendEmail: true,
      isFirstShipment: true,
    };
  }

  // 3. Returning customer
  return {
    status: 'order-placed',
    sendEmail: false,
    isFirstShipment: isFirstShipment(order),
  };
}

module.exports = { determineStatus, isFirstShipment };
