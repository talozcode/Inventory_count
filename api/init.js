const { getBarcodeCache, getSettingValue } = require('../lib/counts');

module.exports = async (req, res) => {
  try {
    const [barcodeCache, sessionStatus] = await Promise.all([
      getBarcodeCache(),
      getSettingValue('Session Status'),
    ]);
    res.status(200).json({
      barcodeCache,
      sessionStatus: sessionStatus || 'Open',
    });
  } catch (err) {
    console.error('init error:', err);
    const msg = err && err.message ? err.message : 'Init failed.';
    res.status(500).json({ error: msg });
  }
};
