// In-process caches.
const NodeCache = require('node-cache');

const productCache = new NodeCache({ stdTTL: 300 }); // Cache products for 5 minutes

module.exports = { productCache };
