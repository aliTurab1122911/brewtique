/**
 * Brewtique CRM — End-to-end Google Sheets + Apps Script loop
 *
 * Features
 * - Web check-in ingestion (doPost) from index.html
 * - E.164 normalization and safe enrichment capture
 * - Same-day duplicate flagging by phone in Pacific time
 * - Unique customer profile table (phone is unique key)
 * - Segmentation (New / Loyal / Irregular)
 * - Retention queue generation
 * - WhatsApp dispatch with TEST/LIVE modes
 * - Webhook support for delivery/read/failed reconciliation
 * - Audit logging in Pacific time
 */

const CONFIG = {
  SPREADSHEET_ID: '1xSmIEUFgX4FCIwnR9zLWVag5yBvgY7qgm3jrAw1JOtE',
  TIMEZONE: 'America/Los_Angeles',

  SHEETS: {
    CHECKINS: 'Checkkins',
    PROFILES: 'Customer_Profiles',
    RETENTION_QUEUE: 'Retention_Queue',
    ANALYTICS: 'Analytics_Daily',
    AUDIT: 'Audit_Log'
  },

  HEADERS: {
    CHECKINS: [
      'Visit_ID', 'Timestamp_PT', 'Date_PT', 'Name',
      'Phone_E164', 'Phone_Raw', 'Country_Code', 'National_Number', 'WhatsApp_Link',
      'IP', 'User_Agent', 'Language', 'Platform', 'Screen', 'Device_Timezone',
      'Duplicate_Flag', 'Duplicate_Reason', 'Source', 'Payload_JSON'
    ],
    PROFILES: [
      'Phone_E164', 'Name', 'Country_Code', 'National_Number',
      'First_Checkin_PT', 'Last_Visit_PT', 'Visit_Count', 'Last_Category',
      'Last_IP', 'Last_User_Agent', 'Updated_At_PT'
    ],
    RETENTION_QUEUE: [
      'Created_At_PT', 'Phone_E164', 'Name', 'Category', 'Template_Name',
      'Status', 'Msg_is_sent', 'WA_Message_ID', 'Retry_Count', 'Last_Attempt_PT', 'Last_Error'
    ],
    ANALYTICS: [
      'Date_PT', 'Total_Checkins', 'Unique_Customers', 'Duplicate_Checkins',
      'New_Customers', 'Loyal_Customers', 'Irregular_Customers',
      'Messages_Queued', 'Messages_Sent', 'Messages_Failed'
    ],
    AUDIT: ['Timestamp_PT', 'Level', 'Action', 'Details_JSON']
  },

  WINDOWS: {
    LOYAL_DAYS: 7,
    IRREGULAR_DAYS: 14
  },

  DISPATCH: {
    MAX_PER_RUN: 80,
    SLEEP_MS: 250,
    RETRY_MINUTES_PROD: 12 * 60,
    RETRY_MINUTES_TEST: 2
  },

  TEMPLATE_BY_CATEGORY: {
    New: 'new_customer_follow_up',
    Loyal: 'loyal_1',
    Irregular: 'irregular_1'
  }
};

/**
 * Test modes (kept intentionally aligned to your samples)
 * - TEST_MODE: scheduling + dry-run behavior for dispatcher operations
 * - WA_TEST_MODE: force WhatsApp fake sends/log-only behavior
 */
function isTestMode_() {
  return (getProp_('TEST_MODE') || 'false').toLowerCase() === 'true';
}
function isWaTestMode_() {
  return (getProp_('WA_TEST_MODE') || 'false').toLowerCase() === 'true';
}

/** --------------------------- Setup --------------------------- */
function oneTimeSetup() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, CONFIG.SHEETS.CHECKINS, CONFIG.HEADERS.CHECKINS);
  ensureSheet_(ss, CONFIG.SHEETS.PROFILES, CONFIG.HEADERS.PROFILES);
  ensureSheet_(ss, CONFIG.SHEETS.RETENTION_QUEUE, CONFIG.HEADERS.RETENTION_QUEUE);
  ensureSheet_(ss, CONFIG.SHEETS.ANALYTICS, CONFIG.HEADERS.ANALYTICS);
  ensureSheet_(ss, CONFIG.SHEETS.AUDIT, CONFIG.HEADERS.AUDIT);

  const props = PropertiesService.getScriptProperties();
  const defaults = {
    TEST_MODE: 'true',
    WA_TEST_MODE: 'true',
    DISABLED: 'false',

    WA_PHONE_NUMBER_ID: '',
    WA_ACCESS_TOKEN: '',
    WA_API_VERSION: 'v22.0',
    WA_TEMPLATE_LANG: 'en_US',
    OVERRIDE_TO: '',

    META_VERIFY_TOKEN: '',
    BUSINESS_NAME: 'Brewtique'
  };

  Object.keys(defaults).forEach((k) => {
    if (props.getProperty(k) === null) props.setProperty(k, defaults[k]);
  });

  installOrUpdateTriggers_();
  auditInfo_('setup_complete', { testMode: isTestMode_(), waTestMode: isWaTestMode_() });
}

function installOrUpdateTriggers_() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    const fn = t.getHandlerFunction();
    if (fn === 'scheduledPipelineRun' || fn === 'scheduledDispatchRun') {
      ScriptApp.deleteTrigger(t);
    }
  });

  if (isTestMode_()) {
    ScriptApp.newTrigger('scheduledPipelineRun').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('scheduledDispatchRun').timeBased().everyMinutes(5).create();
    auditInfo_('triggers_installed', { mode: 'TEST', pipeline: 'hourly', dispatch: 'every 5 min' });
  } else {
    ScriptApp.newTrigger('scheduledPipelineRun').timeBased().everyHours(1).create();
    ScriptApp.newTrigger('scheduledDispatchRun').timeBased().atHour(15).everyDays(1).create();
    auditInfo_('triggers_installed', { mode: 'PROD', pipeline: 'hourly', dispatch: 'daily 15:00 PT' });
  }
}

function stopAllMessaging() {
  setProp_('DISABLED', 'true');
  auditWarn_('stop_all_messaging', {});
}

function resumeMessaging() {
  setProp_('DISABLED', 'false');
  auditInfo_('resume_messaging', {});
}

/** --------------------------- Web Endpoints --------------------------- */
function doGet(e) {
  // CORS-proof check-in path for restrictive browsers/webviews.
  const p = (e && e.parameter) ? e.parameter : {};
  if (String(p.action || '') === 'checkin') {
    try {
      const payload = {
        visit_id: p.visit_id || '',
        name: p.name || '',
        phone_e164: p.phone_e164 || '',
        phone_raw: p.phone_raw || '',
        country_code: p.country_code || '',
        national_number: p.national_number || '',
        whatsapp: p.whatsapp || '',
        ip: p.ip || '',
        user_agent: p.user_agent || '',
        language: p.language || '',
        platform: p.platform || '',
        screen: p.screen || '',
        device_timezone: p.device_timezone || '',
        duplicate_hint: p.duplicate_hint || ''
      };
      const res = ingestCheckin_(payload);
      return ContentService
        .createTextOutput(JSON.stringify(res))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      auditError_('do_get_checkin_error', { err: String(err) });
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'GET_CHECKIN_ERROR' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Meta webhook verification flow
  const mode = p['hub.mode'];
  const token = p['hub.verify_token'];
  const challenge = p['hub.challenge'];

  if (mode === 'subscribe' && token && token === getProp_('META_VERIFY_TOKEN')) {
    auditInfo_('webhook_verify_ok', {});
    return ContentService.createTextOutput(String(challenge || ''));
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'Brewtique CRM endpoint active' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    let body = null;

    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (_) {
        body = null;
      }
    }

    // Form/iframe fallback may post urlencoded payload=<json>
    if (!body && e && e.parameter && e.parameter.payload) {
      try {
        body = JSON.parse(String(e.parameter.payload));
      } catch (_) {
        body = null;
      }
    }

    if (!body) return jsonOut_({ ok: false, error: 'EMPTY_OR_INVALID_BODY' });

    // If payload matches Meta webhook shape => handle status webhook
    if (body && body.entry && Array.isArray(body.entry)) {
      handleWebhookPayload_(body);
      return jsonOut_({ ok: true, source: 'meta_webhook' });
    }

    // Otherwise treat as check-in payload from index.html
    const result = ingestCheckin_(body);
    return jsonOut_(result);

  } catch (err) {
    auditError_('do_post_error', { err: String(err) });
    return jsonOut_({ ok: false, error: 'INVALID_JSON_OR_SERVER_ERROR' });
  }
}

/** --------------------------- Ingestion --------------------------- */
function ingestCheckin_(payload) {
  const ss = getSpreadsheet_();
  const checkins = getCheckinsSheet_(ss) || ensureSheet_(ss, CONFIG.SHEETS.CHECKINS, CONFIG.HEADERS.CHECKINS);
  const profiles = ss.getSheetByName(CONFIG.SHEETS.PROFILES);

  const name = String(payload.name || '').trim();
  const rawPhone = String(payload.phone_raw || payload.phone || '').trim();
  const phone = normalizePhoneE164_(String(payload.phone_e164 || rawPhone));
  if (!name || !phone) return { ok: false, error: 'INVALID_NAME_OR_PHONE' };

  const split = splitE164_(phone);
  const now = new Date();
  const tsPt = fmtPt_(now, 'yyyy-MM-dd HH:mm:ss');
  const dayPt = fmtPt_(now, 'yyyy-MM-dd');

  const dup = isSameDayDuplicate_(checkins, phone, dayPt);

  const ua = String(payload.user_agent || '');
  const ip = String(payload.ip || '');
  const language = String(payload.language || '');
  const platform = String(payload.platform || '');
  const screen = String(payload.screen || '');
  const deviceTz = String(payload.device_timezone || '');

  checkins.appendRow([
    payload.visit_id || Utilities.getUuid(),
    tsPt,
    dayPt,
    name,
    phone,
    rawPhone,
    split.country_code,
    split.national_number,
    whatsappLink_(phone),
    ip,
    ua,
    language,
    platform,
    screen,
    deviceTz,
    dup ? 'TRUE' : 'FALSE',
    dup ? 'SAME_PHONE_SAME_DAY' : '',
    'WEB_CHECKIN',
    safeJson_(payload)
  ]);

  upsertProfile_(profiles, {
    phone,
    name,
    countryCode: split.country_code,
    nationalNumber: split.national_number,
    tsPt,
    ip,
    ua
  });

  updateDailyAnalytics_(dayPt);

  return {
    ok: true,
    duplicate_same_day: dup,
    phone_e164: phone,
    date_pt: dayPt,
    timestamp_pt: tsPt
  };
}

function upsertProfile_(sheet, data) {
  const h = headerMap_(sheet);
  const vals = sheet.getDataRange().getValues();
  const nowPt = fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss');

  for (let i = 1; i < vals.length; i++) {
    const rowPhone = String(vals[i][h['Phone_E164']] || '');
    if (rowPhone === data.phone) {
      const visits = Number(vals[i][h['Visit_Count']] || 0) + 1;
      const rowNum = i + 1;
      sheet.getRange(rowNum, h['Name'] + 1).setValue(data.name);
      sheet.getRange(rowNum, h['Country_Code'] + 1).setValue(data.countryCode);
      sheet.getRange(rowNum, h['National_Number'] + 1).setValue(data.nationalNumber);
      sheet.getRange(rowNum, h['Last_Visit_PT'] + 1).setValue(data.tsPt);
      sheet.getRange(rowNum, h['Visit_Count'] + 1).setValue(visits);
      sheet.getRange(rowNum, h['Last_IP'] + 1).setValue(data.ip);
      sheet.getRange(rowNum, h['Last_User_Agent'] + 1).setValue(data.ua);
      sheet.getRange(rowNum, h['Updated_At_PT'] + 1).setValue(nowPt);
      return;
    }
  }

  sheet.appendRow([
    data.phone,
    data.name,
    data.countryCode,
    data.nationalNumber,
    data.tsPt,
    data.tsPt,
    1,
    'New',
    data.ip,
    data.ua,
    nowPt
  ]);
}

function isSameDayDuplicate_(checkinsSheet, phoneE164, dayPt) {
  const vals = checkinsSheet.getDataRange().getValues();
  if (vals.length < 2) return false;
  const h = headerMap_(checkinsSheet);

  for (let i = vals.length - 1; i >= 1; i--) {
    const p = String(vals[i][h['Phone_E164']] || '');
    const d = String(vals[i][h['Date_PT']] || '');
    if (p === phoneE164 && d === dayPt) return true;
  }
  return false;
}

/** --------------------------- Pipeline --------------------------- */
function scheduledPipelineRun() {
  if (!guardOrExit_('scheduledPipelineRun')) return;

  classifyProfiles_();
  queueRetentionCandidates_();
  updateDailyAnalytics_(fmtPt_(new Date(), 'yyyy-MM-dd'));
  auditInfo_('pipeline_run_complete', {});
}

function classifyProfiles_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(CONFIG.SHEETS.PROFILES);
  const h = headerMap_(sh);
  const vals = sh.getDataRange().getValues();

  const today = ptDateOnly_(new Date());

  for (let i = 1; i < vals.length; i++) {
    const row = vals[i];
    const visits = Number(row[h['Visit_Count']] || 0);
    const lastVisit = parsePtDateTime_(String(row[h['Last_Visit_PT']] || ''));
    if (!lastVisit) continue;

    const diffDays = Math.floor((today.getTime() - ptDateOnly_(lastVisit).getTime()) / 86400000);

    let cat = 'New';
    if (visits <= 1) cat = 'New';
    else if (diffDays <= CONFIG.WINDOWS.LOYAL_DAYS) cat = 'Loyal';
    else cat = 'Irregular';

    sh.getRange(i + 1, h['Last_Category'] + 1).setValue(cat);
    sh.getRange(i + 1, h['Updated_At_PT'] + 1).setValue(fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'));
  }
}

function queueRetentionCandidates_() {
  const ss = getSpreadsheet_();
  const profiles = ss.getSheetByName(CONFIG.SHEETS.PROFILES);
  const queue = ss.getSheetByName(CONFIG.SHEETS.RETENTION_QUEUE);

  const hp = headerMap_(profiles);
  const hq = headerMap_(queue);
  const pRows = profiles.getDataRange().getValues();
  const qRows = queue.getDataRange().getValues();

  const existingToday = new Set();
  const todayPt = fmtPt_(new Date(), 'yyyy-MM-dd');

  for (let i = 1; i < qRows.length; i++) {
    const d = String(qRows[i][hq['Created_At_PT']] || '').slice(0, 10);
    const phone = String(qRows[i][hq['Phone_E164']] || '');
    const tpl = String(qRows[i][hq['Template_Name']] || '');
    if (d === todayPt && phone && tpl) {
      existingToday.add(`${phone}__${tpl}`);
    }
  }

  const append = [];
  for (let i = 1; i < pRows.length; i++) {
    const row = pRows[i];
    const phone = String(row[hp['Phone_E164']] || '');
    const name = String(row[hp['Name']] || '');
    const cat = String(row[hp['Last_Category']] || 'New');
    if (!phone) continue;

    const tpl = CONFIG.TEMPLATE_BY_CATEGORY[cat] || CONFIG.TEMPLATE_BY_CATEGORY.New;
    const key = `${phone}__${tpl}`;
    if (existingToday.has(key)) continue;

    if (cat === 'Irregular' || cat === 'New') {
      append.push([
        fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        phone,
        name,
        cat,
        tpl,
        'Not sent',
        false,
        '',
        0,
        '',
        ''
      ]);
      existingToday.add(key);
    }
  }

  if (append.length) {
    queue.getRange(queue.getLastRow() + 1, 1, append.length, CONFIG.HEADERS.RETENTION_QUEUE.length).setValues(append);
  }
}

/** --------------------------- Dispatch --------------------------- */
function scheduledDispatchRun() {
  if (!guardOrExit_('scheduledDispatchRun')) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    auditWarn_('dispatch_locked', {});
    return;
  }

  try {
    const ss = getSpreadsheet_();
    const q = ss.getSheetByName(CONFIG.SHEETS.RETENTION_QUEUE);
    const h = headerMap_(q);
    const rows = q.getDataRange().getValues();

    const retryMin = isTestMode_() ? CONFIG.DISPATCH.RETRY_MINUTES_TEST : CONFIG.DISPATCH.RETRY_MINUTES_PROD;

    let attempts = 0;
    let sent = 0;
    let failed = 0;

    for (let i = 1; i < rows.length; i++) {
      if (attempts >= CONFIG.DISPATCH.MAX_PER_RUN) break;

      const row = rows[i];
      const status = String(row[h['Status']] || 'Not sent');
      const msgSent = parseBool_(row[h['Msg_is_sent']]);
      const phone = String(row[h['Phone_E164']] || '');
      const name = String(row[h['Name']] || '');
      const tpl = String(row[h['Template_Name']] || '');
      const lastAttempt = String(row[h['Last_Attempt_PT']] || '');
      const retryCount = Number(row[h['Retry_Count']] || 0);

      if (msgSent === true) continue;
      if (status === 'Pending' && !isRetryDue_(lastAttempt, retryMin)) continue;

      attempts++;

      if (!phone || !tpl) {
        writeQueueState_(q, h, i + 1, {
          status: 'Pending',
          msgSent: false,
          retryCount: retryCount + 1,
          lastAttempt: fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          error: 'MISSING_PHONE_OR_TEMPLATE'
        });
        failed++;
        continue;
      }

      const resp = sendWhatsAppTemplate_(phone, tpl, name);
      if (resp.ok) {
        writeQueueState_(q, h, i + 1, {
          status: 'Sent',
          msgSent: true,
          waMessageId: resp.messageId || '',
          retryCount: retryCount + 1,
          lastAttempt: fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          error: ''
        });
        sent++;
      } else {
        writeQueueState_(q, h, i + 1, {
          status: 'Pending',
          msgSent: false,
          retryCount: retryCount + 1,
          lastAttempt: fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          error: String(resp.error || 'SEND_FAILED')
        });
        failed++;
      }

      Utilities.sleep(CONFIG.DISPATCH.SLEEP_MS);
    }

    updateDailyAnalytics_(fmtPt_(new Date(), 'yyyy-MM-dd'), sent, failed);
    auditInfo_('dispatch_done', { attempts, sent, failed, testMode: isTestMode_(), waTestMode: isWaTestMode_() });
  } finally {
    lock.releaseLock();
  }
}

function writeQueueState_(sheet, h, rowNum, p) {
  if (p.status !== undefined) sheet.getRange(rowNum, h['Status'] + 1).setValue(p.status);
  if (p.msgSent !== undefined) sheet.getRange(rowNum, h['Msg_is_sent'] + 1).setValue(p.msgSent);
  if (p.waMessageId !== undefined) sheet.getRange(rowNum, h['WA_Message_ID'] + 1).setValue(p.waMessageId);
  if (p.retryCount !== undefined) sheet.getRange(rowNum, h['Retry_Count'] + 1).setValue(p.retryCount);
  if (p.lastAttempt !== undefined) sheet.getRange(rowNum, h['Last_Attempt_PT'] + 1).setValue(p.lastAttempt);
  if (p.error !== undefined) sheet.getRange(rowNum, h['Last_Error'] + 1).setValue(p.error);
}

/** --------------------------- Webhook reconciliation --------------------------- */
function handleWebhookPayload_(payload) {
  const ss = getSpreadsheet_();
  const q = ss.getSheetByName(CONFIG.SHEETS.RETENTION_QUEUE);
  const h = headerMap_(q);
  const rows = q.getDataRange().getValues();

  (payload.entry || []).forEach((entry) => {
    (entry.changes || []).forEach((ch) => {
      const statuses = ((ch || {}).value || {}).statuses || [];
      statuses.forEach((st) => {
        const messageId = String(st.id || '');
        const status = String(st.status || '').toLowerCase();
        const errObj = (st.errors && st.errors[0]) ? st.errors[0] : null;

        if (!messageId) return;

        for (let i = 1; i < rows.length; i++) {
          const mid = String(rows[i][h['WA_Message_ID']] || '');
          if (mid !== messageId) continue;

          const rowNum = i + 1;
          if (status === 'delivered' || status === 'read') {
            writeQueueState_(q, h, rowNum, { msgSent: true, status: 'Sent', error: '' });
          } else if (status === 'failed') {
            writeQueueState_(q, h, rowNum, { msgSent: false, status: 'Pending', error: safeJson_(errObj || { error: 'FAILED' }) });
          } else {
            writeQueueState_(q, h, rowNum, { msgSent: false, status: 'Pending' });
          }
        }
      });
    });
  });
}

/** --------------------------- WhatsApp API --------------------------- */
function sendWhatsAppTemplate_(toE164, templateName, customerName) {
  const phone = normalizePhoneE164_(toE164);
  if (!phone) return { ok: false, error: 'INVALID_PHONE' };

  if (isWaTestMode_()) {
    auditInfo_('wa_test_send', { to: phone, templateName, customerName });
    return { ok: true, messageId: 'wamid.TEST.' + Date.now(), httpStatus: 'TEST' };
  }

  const token = getProp_('WA_ACCESS_TOKEN');
  const phoneNumberId = getProp_('WA_PHONE_NUMBER_ID');
  const apiVersion = getProp_('WA_API_VERSION') || 'v22.0';
  const lang = getProp_('WA_TEMPLATE_LANG') || 'en_US';
  const overrideTo = normalizePhoneE164_(getProp_('OVERRIDE_TO') || '');
  const to = overrideTo || phone;

  if (!token || !phoneNumberId) return { ok: false, error: 'MISSING_WA_CONFIG' };

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: String(customerName || 'Guest') }]
      }]
    }
  };

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload)
    });

    const code = resp.getResponseCode();
    const bodyText = resp.getContentText();
    let json = {};
    try { json = JSON.parse(bodyText); } catch (_) {}

    if (code >= 200 && code < 300) {
      const messageId = ((json.messages || [])[0] || {}).id || '';
      return { ok: true, messageId, httpStatus: code };
    }

    return { ok: false, httpStatus: code, error: bodyText };
  } catch (err) {
    return { ok: false, httpStatus: 0, error: String(err) };
  }
}

/** --------------------------- Analytics --------------------------- */
function updateDailyAnalytics_(dayPt, sentDelta, failedDelta) {
  const ss = getSpreadsheet_();
  const a = ss.getSheetByName(CONFIG.SHEETS.ANALYTICS);
  const c = getCheckinsSheet_(ss) || ensureSheet_(ss, CONFIG.SHEETS.CHECKINS, CONFIG.HEADERS.CHECKINS);
  const p = ss.getSheetByName(CONFIG.SHEETS.PROFILES);
  const q = ss.getSheetByName(CONFIG.SHEETS.RETENTION_QUEUE);

  const ah = headerMap_(a);
  const ch = headerMap_(c);
  const ph = headerMap_(p);
  const qh = headerMap_(q);

  const cRows = c.getDataRange().getValues().slice(1).filter((r) => String(r[ch['Date_PT']] || '') === dayPt);
  const qRows = q.getDataRange().getValues().slice(1).filter((r) => String(r[qh['Created_At_PT']] || '').slice(0, 10) === dayPt);

  const totalCheckins = cRows.length;
  const duplicateCheckins = cRows.filter((r) => String(r[ch['Duplicate_Flag']] || '') === 'TRUE').length;

  const uniqueSet = new Set(cRows.map((r) => String(r[ch['Phone_E164']] || '')).filter(Boolean));
  const uniqueCustomers = uniqueSet.size;

  const pRows = p.getDataRange().getValues().slice(1);
  let newCustomers = 0;
  let loyalCustomers = 0;
  let irregularCustomers = 0;

  pRows.forEach((r) => {
    const cat = String(r[ph['Last_Category']] || '');
    if (cat === 'New') newCustomers++;
    if (cat === 'Loyal') loyalCustomers++;
    if (cat === 'Irregular') irregularCustomers++;
  });

  const queued = qRows.length;
  const sent = (sentDelta || 0) + qRows.filter((r) => parseBool_(r[qh['Msg_is_sent']]) === true).length;
  const failed = (failedDelta || 0) + qRows.filter((r) => String(r[qh['Status']] || '') === 'Pending' && String(r[qh['Last_Error']] || '')).length;

  const aRows = a.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < aRows.length; i++) {
    if (String(aRows[i][ah['Date_PT']] || '') === dayPt) {
      foundRow = i + 1;
      break;
    }
  }

  const payload = [
    dayPt,
    totalCheckins,
    uniqueCustomers,
    duplicateCheckins,
    newCustomers,
    loyalCustomers,
    irregularCustomers,
    queued,
    sent,
    failed
  ];

  if (foundRow === -1) a.appendRow(payload);
  else a.getRange(foundRow, 1, 1, CONFIG.HEADERS.ANALYTICS.length).setValues([payload]);
}

/** --------------------------- Utilities --------------------------- */
function verifySetup() {
  const ss = getSpreadsheet_();
  const required = Object.values(CONFIG.SHEETS);
  const names = ss.getSheets().map((s) => s.getName());
  const missing = required.filter((n) => !names.includes(n));
  auditInfo_('verify_setup', { missing, testMode: isTestMode_(), waTestMode: isWaTestMode_() });
  return { ok: missing.length === 0, missing, testMode: isTestMode_(), waTestMode: isWaTestMode_() };
}

function guardOrExit_(fnName) {
  const disabled = (getProp_('DISABLED') || 'false').toLowerCase() === 'true';
  if (disabled) {
    auditWarn_('disabled_exit', { fnName });
    return false;
  }
  return true;
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function getSheetWithFallback_(ss, primary, fallbacks) {
  const names = [primary].concat(fallbacks || []);
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!n) continue;
    const sh = ss.getSheetByName(n);
    if (sh) return sh;
  }
  return null;
}

function getCheckinsSheet_(ss) {
  return getSheetWithFallback_(ss, CONFIG.SHEETS.CHECKINS, ['Checkins', 'Sheet1']);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) sh.appendRow(headers);

  const row = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  let mismatch = false;
  for (let i = 0; i < headers.length; i++) {
    if (String(row[i] || '') !== headers[i]) {
      mismatch = true;
      break;
    }
  }
  if (mismatch) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
  return sh;
}

function headerMap_(sh) {
  const row = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};
  row.forEach((h, i) => { if (h) map[String(h)] = i; });
  return map;
}

function fmtPt_(d, format) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, format);
}

function ptDateOnly_(d) {
  const s = fmtPt_(d, 'yyyy-MM-dd');
  return new Date(`${s}T00:00:00`);
}

function parsePtDateTime_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function normalizePhoneE164_(input) {
  if (!input) return '';
  let s = String(input).trim().replace(/[\s\-()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    if (d.length < 10 || d.length > 15) return '';
    return '+' + d;
  }

  const d = s.replace(/\D/g, '');
  if (/^92\d{10}$/.test(d)) return '+' + d;
  if (/^03\d{9}$/.test(d)) return '+92' + d.slice(1);
  if (/^3\d{9}$/.test(d)) return '+92' + d;
  if (/^[1-9]\d{9,14}$/.test(d)) return '+' + d;
  return '';
}

function splitE164_(e164) {
  const d = String(e164 || '').replace(/^\+/, '');
  if (!d) return { country_code: '', national_number: '' };
  for (let len = 3; len >= 1; len--) {
    const cc = d.slice(0, len);
    if (cc) return { country_code: '+' + cc, national_number: d.slice(len) };
  }
  return { country_code: '', national_number: d };
}

function whatsappLink_(e164) {
  return e164 ? `https://wa.me/${String(e164).replace(/^\+/, '')}` : '';
}

function parseBool_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function isRetryDue_(lastAttemptPt, retryMinutes) {
  const dt = parsePtDateTime_(lastAttemptPt);
  if (!dt) return true;
  const diffMin = (Date.now() - dt.getTime()) / 60000;
  return diffMin >= retryMinutes;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeJson_(obj) {
  try { return JSON.stringify(obj || {}); } catch (_) { return '{}'; }
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}
function setProp_(key, value) {
  return PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function auditInfo_(action, details) { audit_('INFO', action, details); }
function auditWarn_(action, details) { audit_('WARN', action, details); }
function auditError_(action, details) { audit_('ERROR', action, details); }

function audit_(level, action, details) {
  try {
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName(CONFIG.SHEETS.AUDIT) || ensureSheet_(ss, CONFIG.SHEETS.AUDIT, CONFIG.HEADERS.AUDIT);
    sh.appendRow([fmtPt_(new Date(), 'yyyy-MM-dd HH:mm:ss'), level, String(action || ''), safeJson_(details)]);
  } catch (err) {
    console.log('AUDIT_FAIL', level, action, details, String(err));
  }
}
