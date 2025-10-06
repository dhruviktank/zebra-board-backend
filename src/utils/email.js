import nodemailer from 'nodemailer';
import crypto from 'crypto';

// Create reusable transporter (lazy)
let transporterPromise;
function getTransporter() {
  if (!transporterPromise) {
    if (!process.env.SMTP_HOST) {
      console.warn('[Email] SMTP_HOST not set, emails will be logged only');
      transporterPromise = Promise.resolve(null);
    } else {
      transporterPromise = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });
    }
  }
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
  const debug = process.env.EMAIL_DEBUG === 'true';
  if (!transporter) {
    console.log('[Email][Mock] To:', to, '\nSubject:', subject, '\nText:', text);
    return { mocked: true };
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'no-reply@example.com',
      to,
      subject,
      text,
      html
    });
    if (debug) console.log('[Email][Sent]', info.messageId, 'to', to, 'primaryLink=', primaryLink);
    return { mocked: false };
  } catch (err) {
    console.warn('[Email][Error] Failed to send verification email:', err);
    throw err;
  }
}
