const { randomUUID } = require('crypto');
const { readRange, appendRow, updateRange, clearRange, insertRowAtTop, upsertRowAtTop, deleteRow } = require('./sheets');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Bangkok';

const AREA_SHOP = 'Shop';
const AREA_WAREHOUSE = 'Warehouse';

const SHEET_PRODUCTS = 'Products';
const SHEET_JCAFE = 'Jcafe_On_Hand';
const SHEET_ENTRIES = 'Count_Entries';
const SHEET_ODOO_UPDATE = 'Odoo_Update';
const SHEET_COMPARE = 'Count_Compare';
const SHEET_UNKNOWN = 'Unknown_Barcodes';
const SHEET_SETTINGS = 'Settings';
const SHEET_BARCODE_CACHE = 'Barcode_Cache';
const SHEET_REPLACED = 'Replaced_Counts';

const REPLACED_HEADERS = [
  'Last Replaced At',
  'Internal Reference',
  'Product Name',
  'Area',
  'Previous Qty',
  'Latest Qty',
  'Replace Count',
  'Last Counter',
  'Last Barcode',
  'History',
  'Notes',
];

const AUTO_NOTES = { 'One side still missing': true, 'Not finished': true };

function safeStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function normalizeBarcode(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\r\n\t]/g, '').replace(/\s+/g, '').trim();
}

function parseTs(v) {
  if (!v) return 0;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? 0 : t;
}

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

async function getBarcodeCache() {
  const rows = await readRange(`${SHEET_BARCODE_CACHE}!A2:G`);
  const cache = {};
  rows.forEach((r) => {
    const barcode = normalizeBarcode(r[0]);
    if (!barcode) return;
    cache[barcode] = {
      internalRef: safeStr(r[1]),
      productName: safeStr(r[2]),
      barcodeType: safeStr(r[3]),
      multiplier: num(r[4]) || 1,
      uom: safeStr(r[5]),
      imageUrl: safeStr(r[6]),
    };
  });
  return cache;
}

async function getSettingValue(name) {
  const rows = await readRange(`${SHEET_SETTINGS}!A2:B`);
  for (const r of rows) {
    if (safeStr(r[0]) === safeStr(name)) return safeStr(r[1]);
  }
  return '';
}

async function lookupBarcode(barcode) {
  const target = normalizeBarcode(barcode);
  if (!target) return { found: false };
  const rows = await readRange(`${SHEET_BARCODE_CACHE}!A2:G`);
  for (const r of rows) {
    if (normalizeBarcode(r[0]) === target) {
      return {
        found: true,
        item: {
          internalRef: safeStr(r[1]),
          productName: safeStr(r[2]),
          barcodeType: safeStr(r[3]),
          multiplier: num(r[4]) || 1,
          uom: safeStr(r[5]),
          imageUrl: safeStr(r[6]),
        },
      };
    }
  }
  return { found: false };
}

async function getEntries() {
  return readRange(`${SHEET_ENTRIES}!A2:K`);
}

function getLatestCountsForProductFromEntries(entries, internalRef) {
  const ref = safeStr(internalRef);
  const result = { productName: '', shop: null, warehouse: null, lastUpdated: 0 };
  entries.forEach((r) => {
    if (safeStr(r[5]) !== ref) return;
    const area = safeStr(r[2]);
    const qtyBase = num(r[8]);
    const ts = parseTs(r[0]);
    if (area === AREA_SHOP) result.shop = qtyBase;
    if (area === AREA_WAREHOUSE) result.warehouse = qtyBase;
    if (safeStr(r[6])) result.productName = safeStr(r[6]);
    if (ts > result.lastUpdated) result.lastUpdated = ts;
  });
  return result;
}

function findLatestEntryForProductAreaFromEntries(entries, internalRef, area) {
  const ref = safeStr(internalRef);
  const a = safeStr(area);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (safeStr(entries[i][5]) === ref && safeStr(entries[i][2]) === a) return entries[i];
  }
  return null;
}

async function findRowByRef(sheetName, internalRef, refColLetter) {
  const rows = await readRange(`${sheetName}!${refColLetter}2:${refColLetter}`);
  const target = safeStr(internalRef);
  for (let i = 0; i < rows.length; i++) {
    if (safeStr(rows[i][0]) === target) return i + 2;
  }
  return 0;
}

async function findProductRow(internalRef) {
  const rows = await readRange(`${SHEET_PRODUCTS}!A2:I`);
  const target = safeStr(internalRef);
  for (let i = 0; i < rows.length; i++) {
    if (safeStr(rows[i][0]) === target) {
      return {
        row: i + 2,
        internalRef: safeStr(rows[i][0]),
        productName: safeStr(rows[i][1]),
      };
    }
  }
  return null;
}

function computeStatusAndNote(counts) {
  const shopReady = counts.shop !== null;
  const whReady = counts.warehouse !== null;
  const finalQty =
    (counts.shop === null ? 0 : counts.shop) +
    (counts.warehouse === null ? 0 : counts.warehouse);
  let status = 'Waiting';
  let autoNote = '';
  if (shopReady && whReady) {
    status = 'Ready';
  } else if (shopReady || whReady) {
    status = '1 area counted';
    autoNote = 'One side still missing';
  } else {
    autoNote = 'Not finished';
  }
  return { status, autoNote, finalQty };
}

async function syncOneProductToOdooUpdate(internalRef, entries) {
  const product = await findProductRow(internalRef);
  if (!product) return;

  const counts = getLatestCountsForProductFromEntries(entries, internalRef);
  const { status, autoNote, finalQty } = computeStatusAndNote(counts);

  const existingRow = await findRowByRef(SHEET_ODOO_UPDATE, internalRef, 'B');

  if (existingRow) {
    const existing = await readRange(`${SHEET_ODOO_UPDATE}!A${existingRow}:F${existingRow}`);
    const existingVals = existing[0] || [];
    const preserveDone = existingVals[0] === true || existingVals[0] === 'TRUE';
    const existingNote = safeStr(existingVals[5]);
    const preserveNote = AUTO_NOTES[existingNote] ? '' : existingNote;
    const finalNote = preserveNote || autoNote;
    const rowValues = [preserveDone, internalRef, product.productName, finalQty, status, finalNote];

    if (preserveDone) {
      await updateRange(`${SHEET_ODOO_UPDATE}!A${existingRow}:F${existingRow}`, [rowValues]);
    } else {
      await upsertRowAtTop(SHEET_ODOO_UPDATE, existingRow, rowValues);
    }
  } else {
    await insertRowAtTop(SHEET_ODOO_UPDATE, [
      false, internalRef, product.productName, finalQty, status, autoNote,
    ]);
  }
}

async function syncOneProductToCompare(internalRef, entries) {
  let onHand = '';
  let name = '';
  const jcafeRow = await findRowByRef(SHEET_JCAFE, internalRef, 'A');
  if (jcafeRow) {
    const vals = await readRange(`${SHEET_JCAFE}!A${jcafeRow}:F${jcafeRow}`);
    const row = vals[0] || [];
    name = safeStr(row[1]);
    onHand = num(row[4]);
  } else {
    const p = await findProductRow(internalRef);
    name = p ? p.productName : '';
  }

  const c = getLatestCountsForProductFromEntries(entries, internalRef);
  const hasPhysical = c.shop !== null || c.warehouse !== null;
  const physical = hasPhysical
    ? (c.shop === null ? 0 : c.shop) + (c.warehouse === null ? 0 : c.warehouse)
    : '';
  const diff = jcafeRow && hasPhysical ? physical - onHand : '';
  const status = jcafeRow
    ? hasPhysical
      ? diff === 0
        ? 'Match'
        : 'Mismatch'
      : 'Not Counted Yet'
    : hasPhysical
    ? 'Counted Only'
    : '';

  if (!status) return;

  const values = [internalRef, name, jcafeRow ? onHand : '', physical, diff, status];
  const existingRow = await findRowByRef(SHEET_COMPARE, internalRef, 'A');
  if (existingRow) {
    await updateRange(`${SHEET_COMPARE}!A${existingRow}:F${existingRow}`, [values]);
  } else {
    await appendRow(`${SHEET_COMPARE}!A:F`, values);
  }
}

function buildReplacedSummaryMapFromEntries(entries) {
  const map = {};
  const grouped = {};

  entries.forEach((r) => {
    const internalRef = safeStr(r[5]);
    const area = safeStr(r[2]);
    if (!internalRef || !area) return;
    const key = internalRef + '||' + area;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      ts: parseTs(r[0]),
      counter: safeStr(r[1]),
      area,
      barcode: safeStr(r[3]),
      internalRef,
      productName: safeStr(r[6]),
      qty: num(r[8]),
      action: safeStr(r[9]),
    });
  });

  Object.keys(grouped).forEach((key) => {
    const arr = grouped[key].sort((a, b) => a.ts - b.ts);
    const replaceRows = arr.filter((x) => x.action === 'Replace');
    if (!replaceRows.length) return;

    const last = arr[arr.length - 1];
    const prev = arr.length >= 2 ? arr[arr.length - 2] : null;
    const first = arr[0];
    const historyText = arr.map((x) => `${formatTs(x.ts)} [${x.area}] ${x.qty}`).join(' | ');

    map[key] = {
      internalRef: last.internalRef,
      productName: last.productName || first.productName,
      area: last.area,
      previousQty: prev ? prev.qty : '',
      latestQty: last.qty,
      replaceCount: replaceRows.length,
      lastCounter: last.counter,
      lastBarcode: last.barcode,
      lastReplacedAt: replaceRows[replaceRows.length - 1].ts,
      historyText,
    };
  });

  return map;
}

async function refreshReplacedCountsSummary(entries) {
  const map = buildReplacedSummaryMapFromEntries(entries);

  const ordered = Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => (b.lastReplacedAt || 0) - (a.lastReplacedAt || 0));

  const rows = ordered.map((r) => [
    r.lastReplacedAt ? formatTs(r.lastReplacedAt) : '',
    r.internalRef,
    r.productName,
    r.area,
    r.previousQty,
    r.latestQty,
    r.replaceCount,
    r.lastCounter,
    r.lastBarcode,
    r.historyText,
    r.replaceCount > 1 ? 'Replaced multiple times' : 'Replaced once',
  ]);

  await updateRange(`${SHEET_REPLACED}!A1:K1`, [REPLACED_HEADERS]);

  const existing = await readRange(`${SHEET_REPLACED}!A2:A`);
  const existingRows = existing.length;

  if (rows.length) {
    await updateRange(`${SHEET_REPLACED}!A2:K${rows.length + 1}`, rows);
  }
  if (existingRows > rows.length) {
    await clearRange(`${SHEET_REPLACED}!A${rows.length + 2}:K${existingRows + 1}`);
  }
}

function validatePayload(payload) {
  if (!payload) throw new Error('Missing payload.');
  if (![AREA_SHOP, AREA_WAREHOUSE].includes(safeStr(payload.area))) {
    throw new Error('Area must be Shop or Warehouse.');
  }
  if (!safeStr(payload.counterName)) throw new Error('Counter name is required.');
  if (!normalizeBarcode(payload.barcode)) throw new Error('Barcode is required.');
  const qty = Number(payload.qtyEntered);
  if (Number.isNaN(qty) || qty < 0) throw new Error('Quantity must be 0 or more.');
}

async function submitCount(payload) {
  validatePayload(payload);

  const barcode = normalizeBarcode(payload.barcode);
  const area = safeStr(payload.area);
  const counterName = safeStr(payload.counterName);
  const qtyEntered = Number(payload.qtyEntered);

  const clientItem = payload.item || null;
  let lookup;
  if (clientItem && safeStr(clientItem.internalRef)) {
    lookup = {
      found: true,
      item: {
        internalRef: safeStr(clientItem.internalRef),
        productName: safeStr(clientItem.productName),
        barcodeType: safeStr(clientItem.barcodeType) || 'Product',
        multiplier: num(clientItem.multiplier) || 1,
        uom: safeStr(clientItem.uom),
        imageUrl: safeStr(clientItem.imageUrl),
      },
    };
  } else {
    lookup = await lookupBarcode(barcode);
  }

  const entryId = randomUUID();
  const nowIso = new Date().toISOString();

  if (!lookup.found) {
    await insertRowAtTop(SHEET_UNKNOWN, [
      nowIso, counterName, area, barcode, qtyEntered, false, 'Barcode not found in Products',
    ]);
    await appendRow(`${SHEET_ENTRIES}!A:K`, [
      nowIso, counterName, area, barcode, 'Unknown', '', '', qtyEntered, '', 'Unknown Barcode', entryId,
    ]);
    return { ok: false, type: 'unknown', message: 'Barcode not found. Saved to Unknown_Barcodes.' };
  }

  const item = lookup.item;
  const qtyBase = qtyEntered;

  const entriesBefore = await getEntries();
  const existingSameArea = findLatestEntryForProductAreaFromEntries(entriesBefore, item.internalRef, area);

  await appendRow(`${SHEET_ENTRIES}!A:K`, [
    nowIso, counterName, area, barcode, item.barcodeType, item.internalRef,
    item.productName, qtyEntered, qtyBase, existingSameArea ? 'Replace' : 'Create', entryId,
  ]);

  const entriesAfter = entriesBefore.concat([[
    nowIso, counterName, area, barcode, item.barcodeType, item.internalRef,
    item.productName, qtyEntered, qtyBase, existingSameArea ? 'Replace' : 'Create', entryId,
  ]]);

  await syncOneProductToOdooUpdate(item.internalRef, entriesAfter);
  await syncOneProductToCompare(item.internalRef, entriesAfter);

  try {
    await refreshReplacedCountsSummary(entriesAfter);
  } catch (err) {
    console.error('refreshReplacedCountsSummary failed (non-fatal):', err);
  }

  return {
    ok: true,
    type: existingSameArea ? 'replaced' : 'saved',
    message: existingSameArea ? 'Count replaced successfully.' : 'Count saved successfully.',
  };
}

module.exports = {
  getBarcodeCache,
  getSettingValue,
  lookupBarcode,
  submitCount,
};
