import crypto from 'crypto';
import https from 'https';

/*
 * email.js (SendGrid API only)
 * ---------------------------------
 * Responsibilities:
 *  - Generate verification token
 *  - Build verification link (frontend preferred, backend fallback)
 *  - Send email via SendGrid Web API (no SMTP path)
 *  - Provide retry with exponential backoff, configurable via env
 *  - Safe mock mode when API key absent
 *
 * Env Variables:
 *  SEND_GRID_PASS                (required for real send) – SendGrid API key
 *  EMAIL_FROM                    e.g. "Zebra Board <no-reply@yourdomain.com>"
 *  FRONTEND_VERIFY_URL           optional, if set builds link to frontend page
 *  BACKEND_BASE_URL / OAUTH_CALLBACK_URL  fallback for backend verify link
 *  EMAIL_API_TIMEOUT_MS          per-attempt timeout (default 10000)
 *  EMAIL_API_RETRIES             total attempts including first (default 3)
 *  EMAIL_API_RETRY_BACKOFF_MS    base backoff in ms (default 500)
 *  EMAIL_API_LOG_FAILURES        if 'true', log each failed attempt (default true)
 */

// Reusable keep-alive HTTPS agent to reduce handshake latency
const sendGridAgent = new https.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 15000 });

export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function sendVerificationEmail({ to, token }) {
  const { subject, text, html } = buildVerificationContent(token);
  const from = process.env.EMAIL_FROM || 'no-reply@example.com';
  if (from.endsWith('@example.com')) {
    console.warn('[Email] Placeholder from address in use. Set EMAIL_FROM to a verified identity.');
  }

  const apiKey = process.env.SEND_GRID_PASS;
  if (!apiKey) {
    console.log('[Email][Mock] (missing SEND_GRID_PASS) To:', to, '\nSubject:', subject, '\nText:', text);
    return { mocked: true };
  }

  const payload = buildSendGridPayload({ from, to, subject, text, html });
  const attempts = toInt(process.env.EMAIL_API_RETRIES, 3);
  const timeoutMs = toInt(process.env.EMAIL_API_TIMEOUT_MS, 10000);
  const baseBackoff = toInt(process.env.EMAIL_API_RETRY_BACKOFF_MS, 500);
  const logFailures = (process.env.EMAIL_API_LOG_FAILURES || 'true').toLowerCase() === 'true';

  let lastErr;
  const startOverall = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const res = await sendGridRequest({ apiKey, payload, timeoutMs });
      const elapsed = Date.now() - attemptStart;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { mocked: false, method: 'api', statusCode: res.statusCode, attempt, elapsedMs: elapsed, totalElapsedMs: Date.now() - startOverall };
      }
      // Non-success status
      lastErr = new Error(`SendGrid API status ${res.statusCode} body: ${truncate(res.body, 500)}`);
      if (logFailures) console.warn(`[Email][Attempt ${attempt}] Non-2xx:`, res.statusCode, truncate(res.body, 200));
    } catch (err) {
      lastErr = err;
      if (logFailures) console.warn(`[Email][Attempt ${attempt}] Error:`, err.message || err);
    }
    if (attempt < attempts) {
      const backoff = baseBackoff * Math.pow(2, attempt - 1); // exponential
      await sleep(backoff);
    }
  }
  console.warn('[Email] All send attempts failed after', attempts, 'attempts');
  throw lastErr || new Error('Unknown email send failure');
}

function buildVerificationContent(token) {
  const backendBase = (process.env.BACKEND_BASE_URL || process.env.OAUTH_CALLBACK_URL || 'http://localhost:4000').replace(/\/$/, '');
  const primaryLink = (process.env.FRONTEND_VERIFY_URL
    ? `${process.env.FRONTEND_VERIFY_URL.replace(/\/$/, '')}?token=${encodeURIComponent(token)}`
    : `${backendBase}/auth/verify-email?token=${encodeURIComponent(token)}`);

  const subject = 'Verify your email address';
  const text = `Welcome to Zebra Board!\n\nPlease verify your email by opening this link:\n${primaryLink}\n\nIf you did not create an account, you can ignore this email.`;
  const html = `<p>Welcome to <strong>Zebra Board</strong>!</p>
  <p>Please verify your email by clicking the button below:</p>
  <p><a href="${primaryLink}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email</a></p>
  <p style="margin-top:12px;">If the button doesn't work, copy this URL:</p>
  <p><code>${primaryLink}</code></p>`;
  return { subject, text, html };
}

function buildSendGridPayload({ from, to, subject, text, html }) {
  return JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: parseFromField(from),
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html }
    ]
  });
}

function sendGridRequest({ apiKey, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: 'api.sendgrid.com',
      path: '/v3/mail/send',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      agent: sendGridAgent,
      timeout: timeoutMs
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error('SendGrid API request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function parseFromField(raw) {
  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return { email: match[2].trim(), name: match[1].trim().replace(/"/g, '').trim() };
  }
  return { email: raw.replace(/"/g, '').trim() };
}

function toInt(val, def) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max) + '…' : str;
}
