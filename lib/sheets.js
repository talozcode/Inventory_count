const { google } = require('googleapis');

let cachedClient = null;

function getSheetsClient() {
  if (cachedClient) return cachedClient;

  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  let rawKey = process.env.GOOGLE_PRIVATE_KEY || '';

  if (!email) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL env var.');
  if (!rawKey) throw new Error('Missing GOOGLE_PRIVATE_KEY env var.');

  rawKey = rawKey.trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');

  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY looks malformed (no BEGIN PRIVATE KEY line). Paste the full private_key value from the service account JSON.');
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

function getSheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('Missing GOOGLE_SHEET_ID env var.');
  return id;
}

async function readRange(range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return res.data.values || [];
}

async function appendRow(range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function updateRange(range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSheetId(),
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function clearRange(range) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: getSheetId(),
    range,
  });
}

let sheetGidCache = null;

async function loadSheetGids() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: 'sheets(properties(sheetId,title))',
  });
  const map = {};
  (res.data.sheets || []).forEach((s) => {
    const title = s.properties && s.properties.title;
    const id = s.properties && s.properties.sheetId;
    if (title != null && id != null) map[title] = id;
  });
  sheetGidCache = map;
}

async function getSheetGid(sheetName) {
  if (!sheetGidCache) await loadSheetGids();
  const gid = sheetGidCache[sheetName];
  if (gid === undefined) throw new Error(`Sheet tab "${sheetName}" not found.`);
  return gid;
}

function toUserEnteredCell(v) {
  if (v === null || v === undefined || v === '') return {};
  if (typeof v === 'boolean') return { userEnteredValue: { boolValue: v } };
  if (typeof v === 'number' && Number.isFinite(v)) return { userEnteredValue: { numberValue: v } };
  return { userEnteredValue: { stringValue: String(v) } };
}

async function insertRowAtTop(sheetName, rowValues) {
  const gid = await getSheetGid(sheetName);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
            inheritFromBefore: false,
          },
        },
        {
          updateCells: {
            rows: [{ values: rowValues.map(toUserEnteredCell) }],
            fields: 'userEnteredValue',
            start: { sheetId: gid, rowIndex: 1, columnIndex: 0 },
          },
        },
      ],
    },
  });
}

async function upsertRowAtTop(sheetName, existingRowNum, rowValues) {
  const gid = await getSheetGid(sheetName);
  const sheets = getSheetsClient();
  const requests = [];

  if (existingRowNum && existingRowNum > 1) {
    requests.push({
      deleteDimension: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: existingRowNum - 1, endIndex: existingRowNum },
      },
    });
  }

  requests.push({
    insertDimension: {
      range: { sheetId: gid, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
      inheritFromBefore: false,
    },
  });

  requests.push({
    updateCells: {
      rows: [{ values: rowValues.map(toUserEnteredCell) }],
      fields: 'userEnteredValue',
      start: { sheetId: gid, rowIndex: 1, columnIndex: 0 },
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: { requests },
  });
}

async function deleteRow(sheetName, rowNum) {
  const gid = await getSheetGid(sheetName);
  const sheets = getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
        },
      }],
    },
  });
}

module.exports = {
  readRange,
  appendRow,
  updateRange,
  clearRange,
  insertRowAtTop,
  upsertRowAtTop,
  deleteRow,
};
