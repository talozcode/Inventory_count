const { submitCount } = require('../lib/counts');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, message: 'Method not allowed' });
    return;
  }
  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const result = await submitCount(payload);
    res.status(200).json(result);
  } catch (err) {
    console.error('submit error:', err);
    res.status(400).json({ ok: false, message: err && err.message ? err.message : 'Submit failed.' });
  }
};
