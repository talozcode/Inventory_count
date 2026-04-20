# Inventory Count Web App

Mobile-friendly web app for inventory counts, backed by Google Sheets. Ported from Google Apps Script so multiple people can count simultaneously from their phones without needing to sign in.

- **Frontend**: static HTML/CSS/JS served from `public/`.
- **Backend**: Node.js serverless functions in `api/` (deployed on Vercel).
- **Storage**: Google Sheets via a service account.

## What it does

- `GET /` – serves the counting UI.
- `GET /api/init` – loads the in-memory barcode cache from the `Barcode_Cache` tab.
- `GET /api/lookup?barcode=...` – server-side barcode lookup (fallback).
- `POST /api/submit` – appends to `Count_Entries`, then upserts the product's row in `Odoo_Update` and `Count_Compare`. Unknown barcodes are appended to `Unknown_Barcodes`.

The Apps Script admin tools (`initializeWorkbookSafe`, `rebuildBarcodeCache`, the full `refreshOdooUpdate` / `refreshCountCompare` rebuilds, and the `onEdit` trigger) stay in the spreadsheet. Run them from the Google Sheet menu when needed.

## Setup

### 1. Create a Google service account

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Enable the **Google Sheets API** for that project.
3. Go to **IAM & Admin → Service accounts**, create a new service account, give it any name.
4. On the service account, open the **Keys** tab, **Add key → Create new key → JSON**. Download the JSON file. Keep it secret.
5. Open the spreadsheet, click **Share**, paste the service account's email (it looks like `name@project.iam.gserviceaccount.com`), and give it **Editor** access.

### 2. Deploy to Vercel

1. Import this GitHub repo into Vercel (**New Project → Import Git Repository**).
2. Leave framework preset as "Other". Build command: leave empty. Output directory: `public`.
3. Add these environment variables (Project → Settings → Environment Variables):

   | Name | Value |
   | --- | --- |
   | `GOOGLE_SHEET_ID` | `1fd0KeDo-QvUf-FH1O3emb_zUs6urG0T_pNVtPag9iLY` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` field from the JSON |
   | `GOOGLE_PRIVATE_KEY` | `private_key` field from the JSON (paste as-is; the `\n` escapes are handled) |

4. Deploy. Open the Vercel URL on your phone – it works on any device without login.

### 3. Keep the Barcode Cache fresh

The web app reads from the `Barcode_Cache` tab. Whenever products change, open the spreadsheet and run **Inventory Count → Rebuild Barcode Cache** from the Apps Script menu.

## Local development

```bash
npm install
npx vercel dev
```

Create a `.env.local` with the three env vars above for local runs.

## Notes on concurrency

Multiple users can submit counts at the same time. `Count_Entries` is the authoritative log and is append-only (atomic). `Odoo_Update` and `Count_Compare` are upserted in place per product; last write wins, which is fine because every write recomputes from the full `Count_Entries` history. The original full-sort/rebuild behavior is available via the Apps Script menu.
