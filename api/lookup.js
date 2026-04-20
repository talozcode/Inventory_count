const { lookupBarcode } = require('../lib/counts');

module.exports = async (req, res) => {
  try {
    const barcode = String((req.query && req.query.barcode) || '');
    const result = await lookupBarcode(barcode);
    res.status(200).json(result);
  } catch (err) {
    console.error('lookup error:', err);
    res.status(500).json({ error: err && err.message ? err.message : 'Lookup failed.' });
  }
};
