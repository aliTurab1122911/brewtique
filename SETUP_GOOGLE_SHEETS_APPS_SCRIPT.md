# Brewtique — Google Sheets + Apps Script Setup Guide

This guide completes the full loop:
- `index.html` check-ins
- Google Sheet data capture
- dedupe + profile generation
- retention queue
- WhatsApp dispatch/webhook

## 1) Files included

- `index.html`
  - Web app endpoint is pre-filled with your deployed URL.
  - Sends E.164 phone, IP, and extra safe device metadata.
- `apps-script.BrewtiqueCRM.gs`
  - Full backend logic for ingestion, pipeline, queue, dispatch, webhook.

## 2) Prepare Google Sheet

Use this Sheet ID (already set in script):
- `1xSmIEUFgX4FCIwnR9zLWVag5yBvgY7qgm3jrAw1JOtE`

No manual tab creation is needed. The script creates/updates:
- `Checkins`
- `Customer_Profiles`
- `Retention_Queue`
- `Analytics_Daily`
- `Audit_Log`

## 3) Create Apps Script project

1. Open the sheet.
2. Go to **Extensions → Apps Script**.
3. Replace the default file content with `apps-script.BrewtiqueCRM.gs` code.
4. Save.
5. In **Project Settings**, set timezone to:
   - `America/Los_Angeles`

## 4) Run initial setup

1. In Apps Script editor, run: `oneTimeSetup`
2. Approve permissions.
3. Then run: `verifySetup`
4. Confirm no missing sheets in logs.

## 5) Configure Script Properties

In Apps Script: **Project Settings → Script properties**, set these:

### Core mode flags (same test-mode pattern as your examples)
- `TEST_MODE` = `true` (start in test)
- `WA_TEST_MODE` = `true` (start in test)
- `DISABLED` = `false`

### WhatsApp Cloud API (for live sending)
- `WA_PHONE_NUMBER_ID` = your Meta phone number ID
- `WA_ACCESS_TOKEN` = your valid long-lived token
- `WA_API_VERSION` = `v22.0`
- `WA_TEMPLATE_LANG` = `en_US`
- `OVERRIDE_TO` = optional test number (E.164), can be blank in production

### Webhook verification token
- `META_VERIFY_TOKEN` = any strong random string

## 6) Deploy web app

1. Click **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Who has access: **Anyone**.
5. Deploy and copy Web app URL.

> Your current URL is already in `index.html`.
> If redeployed with a new URL, update `CONFIG.APPS_SCRIPT_URL` in `index.html`.

## 7) Trigger behavior

Triggers are managed by `installOrUpdateTriggers_()` (called by setup).

- If `TEST_MODE=true`:
  - pipeline hourly (`scheduledPipelineRun`)
  - dispatch every 5 minutes (`scheduledDispatchRun`)
- If `TEST_MODE=false`:
  - pipeline hourly
  - dispatch daily at 3 PM Pacific

If you change `TEST_MODE`, run `installOrUpdateTriggers_()` again.

## 8) Webhook setup in Meta

Webhook callback URL: your Apps Script web app URL.

Verification token: same as `META_VERIFY_TOKEN`.

Subscribe to message status fields so delivery/read/failed updates are posted to `doPost`.

## 9) End-to-end test checklist

1. Keep:
   - `TEST_MODE=true`
   - `WA_TEST_MODE=true`
2. Submit one check-in from `index.html`.
3. Verify new row in `Checkins`.
4. Submit same phone same day; confirm `Duplicate_Flag=TRUE`.
5. Run `scheduledPipelineRun` manually; confirm:
   - `Customer_Profiles` updated
   - `Retention_Queue` rows created
6. Run `scheduledDispatchRun`; in test mode it marks sends without real API calls.
7. Check `Audit_Log` for full event trace.

## 10) Move to production safely

1. Set `WA_TEST_MODE=false` first (keep `TEST_MODE=true` for close observation).
2. Set valid WhatsApp credentials.
3. Optionally set `OVERRIDE_TO` during limited rollout.
4. After validation, set `TEST_MODE=false` and run `installOrUpdateTriggers_()`.

## 11) Emergency stop / resume

- Run `stopAllMessaging()` to halt dispatch loops.
- Run `resumeMessaging()` to continue.


## 12) Troubleshooting “Failed to fetch” on check-in

If the form shows `Couldn’t save your check-in ... (Failed to fetch)`:

1. Confirm Apps Script deployment access is set to **Anyone**.
2. Re-deploy Web App after code updates (new deployment version).
3. Open Web App URL directly in browser and confirm it responds.
4. If testing from a captive portal / embedded webview, CORS can block reading responses.  
   The page now includes a `no-cors` fallback send path for those environments.
5. In Apps Script, check `Audit_Log` and `Executions` to confirm requests are arriving.

