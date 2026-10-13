// Offline JSON-file stand-in for MongoDB (development and tests only).
const { ObjectId } = require('mongodb');

// Offline stand-in for MongoDB — a JSON file on disk with the subset of the
// driver API this server uses. Development and the test suite ONLY: production
// refuses to start on it (see offlineDbAllowed).
function createFileDb(DB_FILE) {
  const fs = require('fs');
  let localDbData = {};
  try {
    if (fs.existsSync(DB_FILE)) {
      localDbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load local DB file:', e);
  }

  const saveLocalDb = () => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(localDbData, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save local DB file:', e);
    }
  };

  // Supports MongoDB comparison operators inside filter values ({ $gt, $gte,
  // $lt, $lte, $ne, $in, $exists }) so the offline mock behaves like a real
  // database — e.g. the promo cooldown query col.promo_claims.findOne({ at: { $gt } })
  // must see the previous claim or the rolling 24h/48h gate silently never triggers.
  const matchesValue = (actual, expected) => {
    // Only treat a plain object as an operator bag when EVERY key is a
    // $-prefixed operator. A subdocument-equality filter (e.g. { coords:
    // { lat: x } }) must fall through to exact matching instead — otherwise
    // its plain keys would be iterated as "operators" and match everything.
    const expectedKeys = expected && typeof expected === 'object' && !(expected instanceof Date)
      ? Object.keys(expected) : [];
    const isOperatorBag = expectedKeys.length > 0 && expectedKeys.every(k => k.startsWith('$'));
    if (isOperatorBag) {
      for (const [op, opVal] of Object.entries(expected)) {
        // Array fields follow Mongo semantics for membership operators.
        if (Array.isArray(actual)) {
          if (op === '$ne') { if (actual.includes(opVal)) return false; continue; }
          if (op === '$nin') { if (Array.isArray(opVal) && opVal.some(x => actual.includes(x))) return false; continue; }
          if (op === '$in') { if (!(Array.isArray(opVal) && opVal.some(x => actual.includes(x)))) return false; continue; }
        }
        // Dates reloaded from the JSON file come back as ISO strings.
        const asTime = (v) => (v instanceof Date ? v.getTime() : v);
        let a = actual instanceof Date ? actual.getTime() : (typeof actual === 'object' && actual !== null ? null : actual);
        if (typeof a === 'string' && opVal instanceof Date && !isNaN(Date.parse(a))) a = Date.parse(a);
        if (op === '$nin') { if (Array.isArray(opVal) && opVal.some(x => asTime(x) === a)) return false; continue; }
        if (op === '$gt') { if (!(a !== null && a > (opVal instanceof Date ? opVal.getTime() : opVal))) return false; }
        else if (op === '$gte') { if (!(a !== null && a >= (opVal instanceof Date ? opVal.getTime() : opVal))) return false; }
        else if (op === '$lt') { if (!(a !== null && a < (opVal instanceof Date ? opVal.getTime() : opVal))) return false; }
        else if (op === '$lte') { if (!(a !== null && a <= (opVal instanceof Date ? opVal.getTime() : opVal))) return false; }
        else if (op === '$ne') { if (a === (opVal instanceof Date ? opVal.getTime() : opVal)) return false; }
        else if (op === '$in') { if (!(Array.isArray(opVal) && opVal.some(x => (x instanceof Date ? x.getTime() : x) === a))) return false; }
        else if (op === '$exists') { if (!!opVal !== (actual !== undefined)) return false; }
        else if (op === '$regex') { if (typeof actual !== 'string' || !new RegExp(opVal).test(actual)) return false; }
      }
      return true;
    }
    if (Array.isArray(actual) && !Array.isArray(expected)) return actual.includes(expected);
    return actual === expected;
  };

  // Update operators the production code uses ($set/$inc/$push/$addToSet/
  // $pull/$unset), applied in place.
  const applyUpdate = (item, update) => {
    if (update.$set) Object.assign(item, update.$set);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) item[k] = (item[k] || 0) + v;
    if (update.$push) for (const [k, v] of Object.entries(update.$push)) item[k] = [...(Array.isArray(item[k]) ? item[k] : []), v];
    if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
      const arr = Array.isArray(item[k]) ? item[k] : [];
      item[k] = arr.includes(v) ? arr : [...arr, v];
    }
    if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) {
      if (Array.isArray(item[k])) item[k] = item[k].filter(x => x !== v);
    }
    if (update.$unset) for (const k of Object.keys(update.$unset)) delete item[k];
  };
  const sortDocs = (docs, spec) => {
    const keys = Object.entries(spec || {});
    if (!keys.length) return docs;
    const val = (d, k) => { const v = d[k]; if (v instanceof Date) return v.getTime(); if (typeof v === 'string' && !isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v); return v; };
    return [...docs].sort((x, y) => {
      for (const [k, dir] of keys) {
        const a = val(x, k), b = val(y, k);
        if (a === b) continue;
        if (a === undefined || a === null) return 1;
        if (b === undefined || b === null) return -1;
        return (a < b ? -1 : 1) * (dir < 0 ? -1 : 1);
      }
      return 0;
    });
  };

  const matchFilter = (item, filter) => {
    if (!filter || Object.keys(filter).length === 0) return true;
    // $or: the item must match at least one sub-filter (used by the
    // customer notification feed: their phone OR a broadcast to everyone).
    if (Array.isArray(filter.$or)) {
      if (!filter.$or.some(sub => matchFilter(item, sub))) return false;
    }
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$or') continue; // handled above
      if (k === '_id' && item._id) {
        if (item._id.toString() !== v.toString()) return false;
        continue;
      }
      if (!matchesValue(item[k], v)) return false;
    }
    return true;
  };

  class FileCollection {
    constructor(name) {
      this.name = name;
    }

    find(filter = {}) {
      const data = localDbData[this.name] || [];
      let filtered = data.filter(item => matchFilter(item, filter));
      let lim = 0;
      const cursor = {
        sort: (spec) => { filtered = sortDocs(filtered, spec); return cursor; },
        limit: (n) => { lim = n || 0; return cursor; },
        toArray: async () => (lim > 0 ? filtered.slice(0, lim) : filtered)
      };
      return cursor;
    }

    async findOne(filter = {}) {
      const data = localDbData[this.name] || [];
      return data.find(item => matchFilter(item, filter)) || null;
    }

    async insertOne(doc) {
      if (!localDbData[this.name]) localDbData[this.name] = [];
      if (!doc._id) doc._id = new ObjectId().toString();
      localDbData[this.name].push(doc);
      saveLocalDb();
      return { insertedId: doc._id, acknowledged: true };
    }

    async insertMany(docs) {
      if (!localDbData[this.name]) localDbData[this.name] = [];
      for (const doc of docs) {
        if (!doc._id) doc._id = new ObjectId().toString();
        localDbData[this.name].push(doc);
      }
      saveLocalDb();
      return { acknowledged: true, insertedCount: docs.length };
    }

    async updateOne(filter, update, options = {}) {
      if (!localDbData[this.name]) localDbData[this.name] = [];
      const list = localDbData[this.name];
      const item = list.find(item => matchFilter(item, filter));
      if (item) {
        applyUpdate(item, update);
        saveLocalDb();
        return { matchedCount: 1, modifiedCount: 1 };
      }
      if (options && options.upsert) {
        const r = await this.findOneAndUpdate(filter, update, options);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: r.value && r.value._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    async updateMany(filter, update) {
      const list = localDbData[this.name] || [];
      let modifiedCount = 0;
      for (const item of list) {
        if (matchFilter(item, filter)) {
          applyUpdate(item, update);
          modifiedCount++;
        }
      }
      if (modifiedCount > 0) saveLocalDb();
      return { matchedCount: modifiedCount, modifiedCount };
    }

    // Atomic find-and-update used by the promo cooldown slot, wallet and
    // stock reservations. Mirrors the MongoDB semantics the production code
    // relies on: returns the updated document after a match (or upsert)
    // and null when nothing matched.
    async findOneAndUpdate(filter, update, options = {}) {
      if (!localDbData[this.name]) localDbData[this.name] = [];
      const list = localDbData[this.name];
      const item = list.find(item => matchFilter(item, filter));
      if (item) {
        applyUpdate(item, update);
        saveLocalDb();
        return { value: item };
      }
      if (options && options.upsert && update && (update.$set || update.$inc || update.$setOnInsert)) {
        const doc = { ...(update.$setOnInsert || {}), ...(update.$set || {}) };
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
        // Upserted docs inherit the equality fields from the filter (Mongo does
        // the same) so the _id/phone/type keys survive the insert.
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && !(v instanceof Date)) continue; // operator bag — skip
          if (doc[k] === undefined) doc[k] = v;
        }
        if (!doc._id) doc._id = new ObjectId().toString();
        list.push(doc);
        saveLocalDb();
        return { value: doc };
      }
      return { value: null };
    }

    async deleteOne(filter) {
      const list = localDbData[this.name] || [];
      const idx = list.findIndex(item => matchFilter(item, filter));
      if (idx !== -1) {
        list.splice(idx, 1);
        saveLocalDb();
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    }

    async deleteMany(filter = {}) {
      const list = localDbData[this.name] || [];
      const before = list.length;
      localDbData[this.name] = list.filter(item => !matchFilter(item, filter));
      saveLocalDb();
      return { deletedCount: before - (localDbData[this.name] || []).length };
    }

    async countDocuments(filter = {}) {
      const data = localDbData[this.name] || [];
      return data.filter(item => matchFilter(item, filter)).length;
    }
  }

  return { collection: (name) => new FileCollection(name) };
}

module.exports = { createFileDb };
