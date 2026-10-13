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

module.exports = { idFilter, samePhone, cleanPhone, isValidPhone, safeEqual };
