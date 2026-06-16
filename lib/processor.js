const { getUntaggedOrders, addOrderTag } = require('../lib/shopify');
const { determineStatus } = require('../lib/status');
const { sendStatusEmail } = require('../lib/email');

async function processOrders() {
  // Look back 48 hours to catch any orders missed in previous runs
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const orders = await getUntaggedOrders(since);

  console.log(`Found ${orders.length} untagged orders since ${since.toISOString()}`);

  const results = [];

  for (const order of orders) {
    try {
      const { status, sendEmail } = determineStatus(order);

      // Tag the order in Shopify
      await addOrderTag(order.id, status);
      console.log(`Tagged order ${order.name} with dhg-status-${status}`);

      // Send email if this status requires one
      let emailResult = { skipped: true };
      if (sendEmail && order.email) {
        emailResult = await sendStatusEmail(status, {
          email: order.email,
          firstName: order.customer?.firstName || '',
          orderNumber: order.name,
          publicNotes: null, // can be extended later
        });
        console.log(`Email sent for order ${order.name} (${status})`);
      }

      results.push({
        order: order.name,
        status,
        emailSent: !emailResult.skipped,
        success: true,
      });

    } catch (err) {
      console.error(`Error processing order ${order.name}:`, err.message);
      results.push({
        order: order.name,
        error: err.message,
        success: false,
      });
    }
  }

  return results;
}

module.exports = { processOrders };
