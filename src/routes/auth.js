import { Router } from 'express';
import { passport } from '../auth/passport.js';
import { signUser, authMiddleware } from '../auth/jwt.js';
import { prisma } from '../prismaClient.js';
import { verifyEmailLimiter } from '../middleware/rateLimiters.js';

const router = Router();

function sanitizeUser(u) { if (!u) return null; const { passwordHash, emailVerificationToken, emailVerificationSentAt, ...rest } = u; return rest; }

function buildRedirect(frontendBase, token, redirectPath) {
  const base = frontendBase.replace(/\/$/, '');
  const path = '/oauth/callback';
  const qp = redirectPath ? `?redirect=${encodeURIComponent(redirectPath)}` : '';
  return `${base}${path}${qp}#token=${encodeURIComponent(token)}`;
}

function encodeState(redirectPath, popup) {
  const payload = { r: redirectPath || '/profile', p: !!popup };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(raw) {
  if (!raw) return { r: '/profile', p: false };
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return { r: '/profile', p: false }; }
}

function popupResponseHtml(token, redirectPath, origin) {
  return `<!DOCTYPE html><html><head><title>Signing in...</title></head><body style="background:#0f1417;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <script>\n(function(){\n  function send(){\n    if (window.opener) {\n      try { window.opener.postMessage({ source:'oauth-popup', token:'${token}', redirect:'${redirectPath}' }, '${origin}'); } catch(e){}\n    }\n    window.close();\n  }\n  send();\n  setTimeout(send, 300);\n})();\n</script>
  <div>Completing sign in...</div></body></html>`;
}

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(user));
  } catch (e) { next(e); }
});

// Email verification endpoint
router.get('/verify-email', verifyEmailLimiter, async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Missing token' });
    const user = await prisma.user.findFirst({ where: { emailVerificationToken: token } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
    const maxHours = Number(process.env.EMAIL_VERIFICATION_EXPIRES_HOURS || 24);
    if (user.emailVerificationSentAt && (Date.now() - user.emailVerificationSentAt.getTime()) > maxHours * 3600 * 1000) {
      return res.status(400).json({ error: 'Token expired' });
    }
    const updated = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), emailVerificationToken: null, emailVerificationSentAt: null } });
    const frontend = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
    const wantsJson = (req.headers['accept'] || '').includes('application/json') || req.query.mode === 'json';
    if (wantsJson) {
      return res.json({ success: true, username: updated.username, verified: true });
    }
    return res.redirect(`${frontend.replace(/\/$/, '')}/login?verified=1&registered=1&user=${encodeURIComponent(updated.username)}`);
  } catch (e) { next(e); }
});

// Unified handler builder to reduce duplication
function providerStart(provider, scope) {
  return (req, res, next) => {
    const redirectPath = req.query.redirect || '/profile';
    const popup = req.query.popup === '1';
    const state = encodeState(redirectPath, popup);
    passport.authenticate(provider, { scope, state })(req, res, next);
  };
}

function providerCallback(provider) {
  return (req, res, next) => {
    const frontendBase = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
    const decoded = decodeState(req.query.state);
    const redirectPath = decoded.r || '/profile';
    const wantPopup = !!decoded.p;
    passport.authenticate(provider, { session: false }, async (err, user) => {
      if (err || !user) return res.redirect(frontendBase + '/login?error=oauth');
      // Mark email verified if available
      if (user.email && !user.emailVerifiedAt) {
        try { await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), emailVerificationToken: null, emailVerificationSentAt: null } }); } catch {/* ignore */}
      }
      const token = signUser(user);
      if (wantPopup) {
        res.send(popupResponseHtml(token, redirectPath, frontendBase));
      } else {
        res.redirect(buildRedirect(frontendBase, token, redirectPath));
      }
    })(req, res, next);
  };
}

// Google
router.get('/google', providerStart('google', ['profile', 'email']));
router.get('/google/callback', providerCallback('google'));
// GitHub
router.get('/github', providerStart('github', ['user:email']));
router.get('/github/callback', providerCallback('github'));

export default router;