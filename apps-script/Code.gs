/**
 * Palang Scheduler — email relay (Google Apps Script web app)
 * Sends confirmation and deletion emails from the owner's Gmail.
 * Companion emails are stored here (Script Properties), never on the public site.
 */

const OWNER_EMAIL = 'shervpey@gmail.com';
const SITE_NAME = 'Palang Scheduler';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'bad_json' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (data.action === 'submit') return reply_(handleSubmit_(data));
    if (data.action === 'delete') return reply_(handleDelete_(data));
    return reply_({ ok: false, error: 'unknown_action' });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return reply_({ ok: true, service: SITE_NAME + ' email relay' });
}

function handleSubmit_(d) {
  const id = clean_(d.id, 64);
  const name = clean_(d.name, 60);
  const email = clean_(d.email, 120).toLowerCase();
  const start = clean_(d.start, 10);
  const end = clean_(d.end, 10);
  const eventName = clean_(d.event, 60) || 'Event';
  const eventTitle = clean_(d.eventTitle, 120) || eventName;
  if (!id || !name || !isEmail_(email) || !isDate_(start) || !isDate_(end)) {
    return { ok: false, error: 'invalid_fields' };
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('c_' + id, JSON.stringify({ name, email, start, end, eventName }));

  const range = fmtRange_(start, end);
  const subject = SITE_NAME + ': ' + eventName + ' — your dates are in';
  const body =
    'Hi ' + name + ',\n\n' +
    'Thanks for adding your dates to ' + eventTitle + '.\n\n' +
    'Name: ' + name + '\n' +
    'Dates: ' + range + '\n\n' +
    'You can see everyone\'s dates on the live calendar.\n\n' +
    '— ' + SITE_NAME;
  MailApp.sendEmail({ to: email, subject: subject, body: body, replyTo: OWNER_EMAIL });
  MailApp.sendEmail({
    to: OWNER_EMAIL,
    subject: SITE_NAME + ': new submission from ' + name + ' (' + eventName + ')',
    body: 'New submission for ' + eventTitle + '.\n\nName: ' + name + '\nEmail: ' + email + '\nDates: ' + range
  });
  return { ok: true };
}

function handleDelete_(d) {
  const ids = Array.isArray(d.ids) ? d.ids.slice(0, 15) : [];
  const props = PropertiesService.getScriptProperties();
  let sent = 0;
  ids.forEach(function (rawId) {
    const id = clean_(rawId, 64);
    const stored = props.getProperty('c_' + id);
    if (!stored) return;
    const c = JSON.parse(stored);
    const range = fmtRange_(c.start, c.end);
    const subject = SITE_NAME + ': ' + c.eventName + ' — your dates were removed';
    const body =
      'Hi ' + c.name + ',\n\n' +
      'Your entry was removed from the ' + c.eventName + ' calendar.\n\n' +
      'Name: ' + c.name + '\n' +
      'Dates: ' + range + '\n\n' +
      'If this was a mistake, you can submit your dates again on the calendar.\n\n' +
      '— ' + SITE_NAME;
    MailApp.sendEmail({ to: c.email, subject: subject, body: body, replyTo: OWNER_EMAIL });
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      subject: SITE_NAME + ': ' + c.name + ' was removed (' + c.eventName + ')',
      body: 'An entry was removed from ' + c.eventName + '.\n\nName: ' + c.name + '\nEmail: ' + c.email + '\nDates: ' + range
    });
    sent++;
  });
  return { ok: true, sent: sent };
}

/** Run this once from the editor to grant permission to send email. */
function authorize() {
  MailApp.getRemainingDailyQuota();
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function isDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function fmtRange_(start, end) {
  const f = function (s) {
    const p = s.split('-').map(Number);
    const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return Utilities.formatDate(dt, 'UTC', 'EEE, MMM d, yyyy');
  };
  return f(start) + ' – ' + f(end);
}
