/**
 * Palang Scheduler — email relay (Google Apps Script web app)
 * Sends confirmation and removal emails from the owner's Gmail.
 * Companion emails are stored here (Script Properties), never on the public site.
 */

const OWNER_EMAIL = 'shervpey@gmail.com';
const SITE_NAME = 'Palang Scheduler';
const SITE_ORIGIN = 'https://shervinhere.github.io/palang-scheduler/';
const BANNER_URL = SITE_ORIGIN + 'assets/banner-email.jpg.jpg';

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
  const place = clean_(d.place, 80);
  const pageUrl = safeUrl_(d.pageUrl);
  if (!id || !name || !isEmail_(email) || !isDate_(start) || !isDate_(end)) {
    return { ok: false, error: 'invalid_fields' };
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('c_' + id, JSON.stringify({ name, email, start, end, eventName, place, pageUrl }));

  const pageTitle = eventName + ' · ' + SITE_NAME;
  const range = fmtRange_(start, end);
  const days = dayCount_(start, end);
  const calTitle = eventName + (place ? ' — ' + place : '');
  const calDetails = 'Your dates for ' + eventName + '.' + (pageUrl ? '\nLive calendar: ' + pageUrl : '');
  const gcal = googleCalLink_(calTitle, start, end, calDetails, place);
  const ics = Utilities.newBlob(buildIcs_(id, calTitle, start, end, calDetails, place), 'text/calendar', eventName + '.ics');

  const html = emailHtml_({
    title: eventName,
    subtitle: place,
    greeting: 'Hi ' + esc_(name) + ',',
    lines: ['Thanks for adding your dates. Here’s what we have for you:'],
    rows: [['Name', name], ['Dates', range + ' (' + days + ' days)']],
    buttons: [
      { label: 'Add to Google Calendar', href: gcal, primary: true },
      pageUrl ? { label: 'View the live calendar', href: pageUrl } : null
    ],
    note: 'Using Apple Calendar or Outlook? Open the attached ' + esc_(eventName) + '.ics file to add it.'
  });
  const text =
    'Hi ' + name + ',\n\n' +
    'Thanks for adding your dates to ' + eventName + (place ? ' (' + place + ')' : '') + '.\n\n' +
    'Name: ' + name + '\nDates: ' + range + ' (' + days + ' days)\n\n' +
    'Add to Google Calendar: ' + gcal + '\n' +
    'Apple Calendar / Outlook: open the attached .ics file.\n' +
    (pageUrl ? 'Live calendar: ' + pageUrl + '\n' : '') +
    '\n— ' + SITE_NAME;

  MailApp.sendEmail({ to: email, subject: pageTitle, body: text, htmlBody: html, attachments: [ics], replyTo: OWNER_EMAIL, name: SITE_NAME });
  MailApp.sendEmail({
    to: OWNER_EMAIL,
    subject: pageTitle + ' — new submission: ' + name,
    name: SITE_NAME,
    htmlBody: emailHtml_({
      title: eventName, subtitle: place, greeting: 'New submission',
      lines: [], rows: [['Name', name], ['Email', email], ['Dates', range + ' (' + days + ' days)']],
      buttons: [pageUrl ? { label: 'View the live calendar', href: pageUrl, primary: true } : null], note: ''
    }),
    body: 'New submission for ' + eventName + '.\n\nName: ' + name + '\nEmail: ' + email + '\nDates: ' + range
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
    const pageTitle = c.eventName + ' · ' + SITE_NAME;
    const html = emailHtml_({
      title: c.eventName,
      subtitle: c.place || '',
      greeting: 'Hi ' + esc_(c.name) + ',',
      lines: ['Your entry was removed from the calendar. If you added it to your own calendar, you may want to remove it there too.',
              'If this was a mistake, you’re welcome to submit your dates again.'],
      rows: [['Name', c.name], ['Dates', range]],
      buttons: [c.pageUrl ? { label: 'View the live calendar', href: c.pageUrl, primary: true } : null],
      note: ''
    });
    MailApp.sendEmail({
      to: c.email, subject: pageTitle, name: SITE_NAME, replyTo: OWNER_EMAIL, htmlBody: html,
      body: 'Hi ' + c.name + ',\n\nYour entry was removed from the ' + c.eventName + ' calendar.\n\nName: ' + c.name + '\nDates: ' + range +
        '\n\nIf this was a mistake, you can submit your dates again' + (c.pageUrl ? ': ' + c.pageUrl : '.') + '\n\n— ' + SITE_NAME
    });
    MailApp.sendEmail({
      to: OWNER_EMAIL, subject: pageTitle + ' — removed: ' + c.name, name: SITE_NAME,
      htmlBody: emailHtml_({
        title: c.eventName, subtitle: c.place || '', greeting: 'Entry removed', lines: [],
        rows: [['Name', c.name], ['Email', c.email], ['Dates', range]], buttons: [], note: ''
      }),
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

// ---------- calendar helpers ----------
function ymd_(iso) { return iso.replace(/-/g, ''); }
function nextDay_(iso) {
  const p = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1, 12));
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}
function googleCalLink_(title, start, end, details, place) {
  // All-day events: end date is exclusive, so use the day after the last day.
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title) +
    '&dates=' + ymd_(start) + '/' + ymd_(nextDay_(end)) +
    '&details=' + encodeURIComponent(details) +
    (place ? '&location=' + encodeURIComponent(place) : '');
}
function icsEscape_(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function buildIcs_(id, title, start, end, details, place) {
  const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Palang Scheduler//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + id + '-' + ymd_(start) + '@palang-scheduler',
    'DTSTAMP:' + stamp,
    'DTSTART;VALUE=DATE:' + ymd_(start),
    'DTEND;VALUE=DATE:' + ymd_(nextDay_(end)),
    'SUMMARY:' + icsEscape_(title),
    'DESCRIPTION:' + icsEscape_(details),
    place ? 'LOCATION:' + icsEscape_(place) : null,
    'TRANSP:TRANSPARENT',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

// ---------- email layout ----------
function emailHtml_(o) {
  const rows = (o.rows || []).map(function (r) {
    return '<tr><td style="padding:6px 16px 6px 0;color:#6b6a66;font-size:14px;white-space:nowrap;vertical-align:top">' + esc_(r[0]) +
      '</td><td style="padding:6px 0;font-size:15px;font-weight:600;color:#1d1d1b">' + esc_(r[1]) + '</td></tr>';
  }).join('');
  const buttons = (o.buttons || []).filter(Boolean).map(function (b) {
    const style = b.primary
      ? 'background:#1d1d1b;color:#ffffff;border:1px solid #1d1d1b;'
      : 'background:#ffffff;color:#1d1d1b;border:1px solid #c9c6bf;';
    return '<a href="' + esc_(b.href) + '" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;border-radius:8px;' +
      'font-size:15px;font-weight:600;text-decoration:none;' + style + '">' + esc_(b.label) + '</a>';
  }).join('');
  const lines = (o.lines || []).map(function (l) { return '<p style="margin:0 0 12px;font-size:15px;color:#3b3a37">' + esc_(l) + '</p>'; }).join('');
  return '<div style="background:#f6f5f2;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e3e1dc;overflow:hidden">' +
    '<img src="' + BANNER_URL + '" width="520" alt="" style="display:block;width:100%;max-width:520px;height:auto;border:0">' +
    '<div style="padding:22px 22px 24px">' +
    '<h1 style="margin:0;font-size:22px;color:#1d1d1b">' + esc_(o.title) + '</h1>' +
    (o.subtitle ? '<p style="margin:2px 0 18px;color:#6b6a66;font-size:15px">' + esc_(o.subtitle) + '</p>' : '<div style="height:14px"></div>') +
    '<p style="margin:0 0 12px;font-size:15px;color:#1d1d1b">' + o.greeting + '</p>' +
    lines +
    (rows ? '<table role="presentation" style="border-collapse:collapse;margin:4px 0 18px">' + rows + '</table>' : '') +
    (buttons ? '<div style="margin:0 0 8px">' + buttons + '</div>' : '') +
    (o.note ? '<p style="margin:8px 0 0;font-size:13px;color:#6b6a66">' + o.note + '</p>' : '') +
    '<p style="margin:22px 0 0;font-size:13px;color:#9a9993">— ' + SITE_NAME + '</p>' +
    '</div></div></div>';
}

// ---------- utils ----------
function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}
function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeUrl_(u) {
  const s = clean_(u, 300);
  return s.indexOf(SITE_ORIGIN) === 0 ? s : '';
}
function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
function isDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function dayCount_(start, end) {
  const a = start.split('-').map(Number), b = end.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000) + 1;
}
function fmtRange_(start, end) {
  const f = function (s) {
    const p = s.split('-').map(Number);
    const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return Utilities.formatDate(dt, 'UTC', 'EEE, MMM d, yyyy');
  };
  return f(start) + ' – ' + f(end);
}
