import nodemailer from 'nodemailer';
import crypto from 'crypto';
import https from 'https';

// Lazy singleton transporter
let transporterPromise;
function getTransporter() {
  if (transporterPromise) return transporterPromise;

  // SendGrid SMTP (explicit variables)
  if (process.env.SEND_GRID_SERVER && process.env.SEND_GRID_USER && process.env.SEND_GRID_PASS) {
    const host = process.env.SEND_GRID_SERVER; // usually smtp.sendgrid.net
    const port = Number(process.env.SEND_GRID_PORT || 587);
    const secure = process.env.SEND_GRID_SECURE === 'true' || port === 465;
    // Allow opting out of SMTP to use Web API directly via EMAIL_TRANSPORT_STRATEGY=api
    if ((process.env.EMAIL_TRANSPORT_STRATEGY || 'smtp').toLowerCase() === 'smtp') {
      transporterPromise = Promise.resolve(nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user: process.env.SEND_GRID_USER, pass: process.env.SEND_GRID_PASS },
        connectionTimeout: 10000, // 10s
        greetingTimeout: 10000,
        socketTimeout: 20000
      }));
    } else {
      transporterPromise = Promise.resolve(null); // forces API path
    }
    return transporterPromise;
  }

  // Legacy generic SMTP support (optional): if someone still sets SMTP_HOST (fallback)
  if (process.env.SMTP_HOST) {
    transporterPromise = Promise.resolve(nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    }));
    return transporterPromise;
  }

  console.warn('[Email] No SMTP configuration detected (expecting SEND_GRID_* or SMTP_*); operating in mock mode');
  transporterPromise = Promise.resolve(null);
  return transporterPromise;
}

export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function sendVerificationEmail({ to, token }) {
  // Determine link strategy:
  // 1. If FRONTEND_VERIFY_URL is set, assume a frontend page will call backend.
  // 2. Otherwise send direct backend endpoint so user click completes verification immediately.
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

  const transporter = await getTransporter();
  // Debug/verification logic removed for production cleanliness.
  if (!transporter) {
    console.log('[Email][Mock] To:', to, '\nSubject:', subject, '\nText:', text);
    return { mocked: true };
  }
  try {
    const from = process.env.EMAIL_FROM || 'no-reply@example.com';
    if (from.endsWith('@example.com')) {
      console.warn('[Email] Using placeholder from address (no-reply@example.com). Configure a verified SendGrid sender via EMAIL_FROM to avoid 550 errors.');
    }
    if (transporter) {
      try {
        const info = await transporter.sendMail({ from, to, subject, text, html });
        return { mocked: false, method: 'smtp' };
      } catch (err) {
        if (err && err.code === 'ETIMEDOUT') {
          console.warn('[Email][SMTP Timeout] Falling back to SendGrid Web API');
          return await sendViaSendGridApi({ from, to, subject, text, html });
        }
        throw err;
      }
    } else {
      // Direct API strategy (EMAIL_TRANSPORT_STRATEGY=api)
      return await sendViaSendGridApi({ from, to, subject, text, html });
    }
  } catch (err) {
    if (err && err.code === 'EAUTH') {
      console.warn('[Email][AuthError] SMTP authentication failed. Check user / password (API key) and host/port/secure settings.');
    } else {
      console.warn('[Email][Error] Failed to send verification email:', err);
    }
    throw err;
  }
}

async function sendViaSendGridApi({ from, to, subject, text, html }) {
  const apiKey = process.env.SEND_GRID_PASS; // Using same secret (API key)
  if (!apiKey) {
    console.warn('[Email][API] Missing SEND_GRID_PASS (API key). Cannot send.');
    return { mocked: true, method: 'api-missing-key' };
  }
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: parseFromField(from),
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html }
    ]
  });
  const options = {
    method: 'POST',
    host: 'api.sendgrid.com',
    path: '/v3/mail/send',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 10000
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ mocked: false, method: 'api', statusCode: res.statusCode });
      } else {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          const msg = `[Email][API Error] Status ${res.statusCode} Body: ${body}`;
          console.warn(msg);
          reject(new Error(msg));
        });
      }
    });
    req.on('error', err => {
      console.warn('[Email][API Request Error]', err.message || err);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy(new Error('SendGrid API request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function parseFromField(raw) {
  // Supports formats: 'Name <email@domain>' or just 'email@domain'
  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return { email: match[2].trim(), name: match[1].trim().replace(/"/g, '').trim() };
  }
  return { email: raw.replace(/"/g, '').trim() };
}
