const { logQrScan } = require('../lib/store');

// Tracked QR redirect. A printed QR encodes  /api/qr?c=<code> ; each scan is
// logged (append-only, in audit_log) and the visitor is 302-redirected to the
// order site. Counts surface in the team dashboard (📱 QR — סריקות).
//
// Unauthenticated + best-effort: logging must NEVER block or break the redirect,
// so a scanning customer always lands on the site even if the DB write fails.

// Fixed destination — never an open redirect (we never honour a caller-supplied
// target URL). To send different codes elsewhere later, add them to this map.
const DEFAULT_DESTINATION = 'https://order.prinuk.co.il/';
const DESTINATIONS = {
  // main: 'https://order.prinuk.co.il/',
};

// Normalise a campaign code to a short, safe slug (a-z, 0-9, _ , -).
function cleanCode(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return c || 'meida';
}

// Has this browser already been counted for this code? (first hit → unique person)
function hasSeenCookie(req, code) {
  const cookie = (req.headers && req.headers.cookie) || '';
  return cookie.split(';').some((p) => p.trim() === 'qr_' + code + '=1');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = cleanCode(req.query && req.query.c);
  const destination = DESTINATIONS[code] || DEFAULT_DESTINATION;
  const unique = !hasSeenCookie(req, code);

  // Best-effort log — wrapped so a failure can't stop the redirect.
  try {
    await logQrScan({
      code,
      unique,
      userAgent: req.headers && req.headers['user-agent'],
      referer: req.headers && (req.headers.referer || req.headers.referrer),
    });
  } catch (e) {
    console.error('qr handler log error:', e && e.message);
  }

  // Mark this browser as counted for ~400 days so repeat scans don't inflate uniques.
  if (unique) {
    res.setHeader('Set-Cookie', 'qr_' + code + '=1; Max-Age=34560000; Path=/api/qr; HttpOnly; SameSite=Lax');
  }
  // Never cache the redirect (every scan must hit the counter).
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.writeHead(302, { Location: destination });
  return res.end();
};
