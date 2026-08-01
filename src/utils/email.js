import crypto from 'crypto';
import nodemailer from 'nodemailer';
import https from 'https';

/*
 * email.js (SMTP via Nodemailer OR Resend API)
 * ---------------------------------
 * Responsibilities:
 *  - Generate verification token
 *  - Build verification link (frontend preferred, backend fallback)
 *  - Send email via either:
 *      - SMTP (Nodemailer, pooled connections), or
 *      - Resend HTTP API (useful when outbound SMTP ports are blocked,
 *        e.g. on Render's free/starter tiers)
 *  - Provide retry with exponential backoff, configurable via env
 *  - Safe mock mode when credentials for the selected method are absent
 *
 * Env Variables:
 *  EMAIL_VERIFICATION_METHOD     "smtp" or "api" (default "smtp")
 *
 *  --- SMTP method ---
 *  SMTP_HOST                     required for real send – e.g. smtp.gmail.com
 *  SMTP_PORT                     required for real send – e.g. 465 or 587
 *  SMTP_SECURE                   'true' for port 465 (implicit TLS), 'false' otherwise
 *  SMTP_USER                     required for real send – Gmail address / SMTP username
 *  SMTP_PASS                     required for real send – Gmail app password / SMTP password
 *
 *  --- API method (Resend) ---
 *  RESEND_API_KEY                required for real send via Resend
 *
 *  --- Shared ---
 *  EMAIL_FROM                    e.g. "Zebra Board <no-reply@yourdomain.com>"
 *  FRONTEND_VERIFY_URL           optional, if set builds link to frontend page
 *  BACKEND_BASE_URL / OAUTH_CALLBACK_URL  fallback for backend verify link
 *  EMAIL_API_TIMEOUT_MS          per-attempt timeout (default 10000)
 *  EMAIL_API_RETRIES             total attempts including first (default 3)
 *  EMAIL_API_RETRY_BACKOFF_MS    base backoff in ms (default 500)
 *  EMAIL_API_LOG_FAILURES        if 'true', log each failed attempt (default true)
 */

// Reusable pooled SMTP transporter to reduce connection/handshake overhead
let transporter = null;
let transporterVerified = false;

// Reusable keep-alive HTTPS agent for the Resend API path
const resendAgent = new https.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 15000 });

function getVerificationMethod() {
  const method = (process.env.EMAIL_VERIFICATION_METHOD || 'smtp').toLowerCase();
  return method === 'api' ? 'api' : 'smtp';
}

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = toInt(process.env.SMTP_PORT, 587);
  const secure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  console.log('[Email][SMTP] Config:', {
    host,
    port,
    secure,
    user,
    passLength: pass ? pass.length : 0 // never log the raw credential
  });

  transporter = nodemailer.createTransport({
    host,
    port,
    family: 4,
    secure,
    auth: (user && pass) ? { user, pass } : undefined,
    pool: false,
    maxConnections: 5,
    maxMessages: 100,
    logger: true,
    debug: true,
    connectionTimeout: toInt(process.env.EMAIL_API_TIMEOUT_MS, 10000),
    greetingTimeout: toInt(process.env.EMAIL_API_TIMEOUT_MS, 10000),
    socketTimeout: toInt(process.env.EMAIL_API_TIMEOUT_MS, 10000)
  });

  return transporter;
}

// Verify transporter on startup (best-effort; failures are logged, not thrown,
// so app boot isn't blocked and mock mode / retries can still function).
// Only relevant when EMAIL_VERIFICATION_METHOD is "smtp".
export async function verifyTransporter() {
  if (getVerificationMethod() !== 'smtp') {
    console.log('[Email] EMAIL_VERIFICATION_METHOD is "api" — skipping SMTP transporter verification.');
    return { verified: false, mocked: false, skipped: true };
  }
  if (!hasSmtpCredentials()) {
    console.log('[Email][Mock] (missing SMTP_HOST/SMTP_USER/SMTP_PASS) Skipping transporter verification.');
    return { verified: false, mocked: true };
  }
  try {
    const t = getTransporter();
    await t.verify();
    transporterVerified = true;
    console.log('[Email] SMTP transporter verified successfully.');
    return { verified: true, mocked: false };
  } catch (err) {
    transporterVerified = false;
    console.warn('[Email] SMTP transporter verification failed:', err.message || err);
    return { verified: false, mocked: false, error: err };
  }
}

// Fire-and-forget verification at module load, mirroring "verify on startup".
verifyTransporter();

function hasSmtpCredentials() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function hasResendCredentials() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function sendVerificationEmail({ to, token }) {
  const { subject, text, html } = buildVerificationContent(token);
  const from = process.env.EMAIL_FROM || 'no-reply@example.com';
  if (from.endsWith('@example.com')) {
    console.warn('[Email] Placeholder from address in use. Set EMAIL_FROM to a verified identity.');
  }

  const method = getVerificationMethod();
  const hasCreds = method === 'api' ? hasResendCredentials() : hasSmtpCredentials();

  if (!hasCreds) {
    const missing = method === 'api' ? 'RESEND_API_KEY' : 'SMTP_HOST/SMTP_USER/SMTP_PASS';
    console.log(`[Email][Mock] (missing ${missing}) To:`, to, '\nSubject:', subject, '\nText:', text);
    return { mocked: true };
  }

  const message = { from, to, subject, text, html };
  const attempts = toInt(process.env.EMAIL_API_RETRIES, 3);
  const timeoutMs = toInt(process.env.EMAIL_API_TIMEOUT_MS, 10000);
  const baseBackoff = toInt(process.env.EMAIL_API_RETRY_BACKOFF_MS, 500);
  const logFailures = (process.env.EMAIL_API_LOG_FAILURES || 'true').toLowerCase() === 'true';

  let lastErr;
  const startOverall = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const res = method === 'api'
        ? await resendSendRequest({ message, timeoutMs })
        : await smtpSendRequest({ message, timeoutMs });
      const elapsed = Date.now() - attemptStart;
      return {
        mocked: false,
        method,
        messageId: res.messageId,
        accepted: res.accepted,
        attempt,
        elapsedMs: elapsed,
        totalElapsedMs: Date.now() - startOverall
      };
    } catch (err) {
      lastErr = err;
      if (logFailures) console.warn(`[Email][${method}][Attempt ${attempt}] Error:`, err.message || err);
    }
    if (attempt < attempts) {
      const backoff = baseBackoff * Math.pow(2, attempt - 1); // exponential
      await sleep(backoff);
    }
  }
  console.warn(`[Email][${method}] All send attempts failed after`, attempts, 'attempts');
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

// --- SMTP path (Nodemailer) ---

function smtpSendRequest({ message, timeoutMs }) {
  const t = getTransporter();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('SMTP send request timeout'));
    }, timeoutMs);

    t.sendMail(message)
      .then(info => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ messageId: info.messageId, accepted: info.accepted });
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// --- API path (Resend) ---

function resendSendRequest({ message, timeoutMs }) {
  const payload = JSON.stringify({
    from: message.from,
    to: [message.to],
    subject: message.subject,
    text: message.text,
    html: message.html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      host: 'api.resend.com',
      path: '/emails',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      agent: resendAgent,
      timeout: timeoutMs
    }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        const statusOk = res.statusCode >= 200 && res.statusCode < 300;
        if (!statusOk) {
          return reject(new Error(`Resend API status ${res.statusCode} body: ${truncate(body, 500)}`));
        }
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* leave parsed empty if body isn't JSON */ }
        resolve({ messageId: parsed.id, accepted: [message.to] });
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error('Resend API request timeout'));
    });
    req.write(payload);
    req.end();
  });
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