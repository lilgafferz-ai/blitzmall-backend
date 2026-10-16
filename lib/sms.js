// SMS delivery via Africa's Talking. Only the owner's optional closing-report
// copy uses it now: customer sign-in is phone + PIN (SMS codes were removed).
// Local 07xxxxxxxx / 01xxxxxxxx -> +2547xxxxxxxx / +2541xxxxxxxx for the SMS
// gateway. Africa's Talking documents the `to` field in international format
// WITH the leading +, so it is emitted that way.
const toIntlPhone = (p) => {
  const d = String(p).replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('254')) return '+' + d;
  if (d.startsWith('0')) return '+254' + d.slice(1);
  return '+254' + d;
};
// Africa's Talking (Nairobi-based, KES billing) via its plain HTTP v1 API — no
// SDK, uses Node's global fetch.
const smsConfigured = () => !!(process.env.AT_USERNAME && process.env.AT_API_KEY);
// The sandbox lives on its own host — the username "sandbox" (or AT_SANDBOX=true)
// switches automatically so a test API key doesn't silently post to production.
const atMessagingUrl = () =>
  ((process.env.AT_SANDBOX === 'true' || process.env.AT_USERNAME === 'sandbox')
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging');
// Any SMS through Africa's Talking (the owner's closing report).
// Resolves true only when the gateway reports per-recipient Success.
async function sendSms(phone, message) {
  const to = toIntlPhone(phone);
  if (smsConfigured() && to) {
    try {
      const form = new URLSearchParams({ username: process.env.AT_USERNAME, to, message });
      // Kenyan networks only deliver from a REGISTERED alphanumeric Sender ID /
      // shortcode — Africa's Talking's shared default sender is dropped by the
      // network. Set AT_SENDER_ID to the approved ID (leave unset if the account
      // has no approved sender yet; AT will report the rejection).
      if (process.env.AT_SENDER_ID) form.set('from', process.env.AT_SENDER_ID);
      const res = await fetch(atMessagingUrl(), {
        method: 'POST',
        headers: {
          apiKey: process.env.AT_API_KEY,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      });
      const raw = await res.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch (e) { /* non-JSON error page */ }
      // Africa's Talking answers HTTP 200/201 even when the message FAILED per
      // recipient — the real result is in SMSMessageData.Recipients[].status
      // ("Success" | "Failed" with a statusCode: 101 invalid number,
      // 102 insufficient balance, 103 user inactive, 104 sender ID not allowed).
      // Only an explicit per-recipient "Success" counts as delivered.
      const recipients = (payload && payload.SMSMessageData && Array.isArray(payload.SMSMessageData.Recipients))
        ? payload.SMSMessageData.Recipients : [];
      const delivered = res.ok && recipients.some(r => String(r && r.status || '').toLowerCase() === 'success');
      if (!delivered) {
        const detail = recipients.length
          ? recipients.map(r => `${r.number || to}: ${r.status || 'Failed'} (code ${r.statusCode})`).join(', ')
          : `HTTP ${res.status} ${String(raw).slice(0, 200)}`;
        console.error(`[sms-failed] ${phone} (${detail})`);
        return false;
      }
      console.log(`[sms-sent] ${phone} (${(payload.SMSMessageData && payload.SMSMessageData.Message) || 'delivered'})`);
      return true;
    } catch (e) {
      console.error(`[sms-failed] ${phone} (${e.message})`);
      return false;
    }
  }
  console.log(`[sms-skipped] ${phone} (SMS provider not configured)`);
  return false;
}

module.exports = { toIntlPhone, smsConfigured, atMessagingUrl, sendSms };
