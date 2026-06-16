const { getEmailTemplate, EMAIL_STATUSES } = require('../emails/templates');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'hello@detectivehawkgames.com';
const FROM_NAME = 'Detective Hawk Games';

async function sendStatusEmail(status, { email, firstName, orderNumber, publicNotes } = {}) {
  if (!EMAIL_STATUSES.has(status)) return { skipped: true, reason: 'no email for this status' };
  if (!email) return { skipped: true, reason: 'no customer email' };

  const template = getEmailTemplate(status, { firstName, orderNumber, publicNotes });
  if (!template) return { skipped: true, reason: 'no template found' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [email],
      subject: template.subject,
      html: template.html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend failed: ${res.status} ${err}`);
  }

  return await res.json();
}

module.exports = { sendStatusEmail };
