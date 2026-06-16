const { processOrders } = require('../../lib/processor');

// Vercel cron - runs at 6am and 12pm ET daily
// Cron schedule set in vercel.json

export default async function handler(req, res) {
  // Secure the endpoint with a secret so it can't be triggered externally
  const cronSecret = req.headers['authorization'];
  if (cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log(`DHG cron triggered at ${new Date().toISOString()}`);
    const results = await processOrders();

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return res.status(200).json({
      message: `Processed ${results.length} orders. ${succeeded} succeeded, ${failed} failed.`,
      results,
    });

  } catch (err) {
    console.error('Cron job failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
