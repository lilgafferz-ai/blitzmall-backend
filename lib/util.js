// Small shared helpers.
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const idFilter = (id) => ({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id });
// A route whose :phone param must belong to the signed-in customer.
const samePhone = (raw, phone) => String(raw || '').replace(/[^0-9]/g, '') === String(phone);
const cleanPhone = (p) => String(p || '').replace(/[^0-9]/g, '');
const isValidPhone = (p) => /^\d{9,13}$/.test(p);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// JSON reply with an ETag. The apps poll some big lists (the HQ order list
// every 15 s, the product list after every sale); a client that sends back
// the ETag it last saw (If-None-Match) gets an empty 304 when nothing changed
// instead of the whole payload again. (/api is Cache-Control: no-store, so the
// apps send the header themselves.)
function sendJsonCached(req, res, data) {
  const body = JSON.stringify(data);
  const etag = '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"';
  res.set('ETag', etag);
  if (req.get('If-None-Match') === etag) return res.status(304).end();
  res.type('application/json').send(body);
}

module.exports = { idFilter, samePhone, cleanPhone, isValidPhone, safeEqual, sendJsonCached };
