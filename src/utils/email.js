import nodemailer from 'nodemailer';
import crypto from 'crypto';

// Lazy singleton transporter
let transporterPromise;
function getTransporter() {
  if (transporterPromise) return transporterPromise;

  // SendGrid SMTP (explicit variables)
  if (process.env.SEND_GRID_SERVER && process.env.SEND_GRID_USER && process.env.SEND_GRID_PASS) {
    const host = process.env.SEND_GRID_SERVER; // usually smtp.sendgrid.net
    const port = Number(process.env.SEND_GRID_PORT || 587);
    const secure = process.env.SEND_GRID_SECURE === 'true' || port === 465;
    transporterPromise = Promise.resolve(nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: process.env.SEND_GRID_USER, pass: process.env.SEND_GRID_PASS }
    }));
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
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html
    });
    return { mocked: false };
  } catch (err) {
    if (err && err.code === 'EAUTH') {
      console.warn('[Email][AuthError] SMTP authentication failed. Check user / password (API key) and host/port/secure settings.');
    } else {
      console.warn('[Email][Error] Failed to send verification email:', err);
    }
    throw err;
  }
}
