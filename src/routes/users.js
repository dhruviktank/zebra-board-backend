import { Router } from 'express';
import { prisma } from '../prismaClient.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { generateVerificationToken, sendVerificationEmail } from '../utils/email.js';
import { registerLimiter, verificationStatusLimiter } from '../middleware/rateLimiters.js';
import { AppError, badRequest, unauthorized, forbidden } from '../middleware/errors.js';
import { signUser } from '../auth/jwt.js';

const router = Router();

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, emailVerificationToken, emailVerificationSentAt, ...rest } = u;
  return rest;
}

// Create user (email verification flow if email provided)
router.post('/', registerLimiter, async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
  if (!username || !password) throw badRequest('username and password required');
    const passwordHash = await hashPassword(password);
    let data = { username, email, passwordHash };
    let verificationInitiated = false;
    if (email) {
      const token = generateVerificationToken();
      data.emailVerificationToken = token;
      data.emailVerificationSentAt = new Date();
      verificationInitiated = true;
    }
    const user = await prisma.user.create({ data });
    if (verificationInitiated) {
      try { await sendVerificationEmail({ to: email, token: user.emailVerificationToken }); }
      catch (e) { console.warn('[Email] send failure', e); }
      // Do NOT expose user object yet; require verification first.
      return res.status(202).json({ pendingVerification: true });
    }
    // No email provided -> treat as directly usable account
    return res.status(201).json({ pendingVerification: false, user: sanitizeUser(user) });
  } catch (e) { next(e); }
});

// List users (basic pagination)
router.get('/', async (req, res, next) => {
  try {
    const take = Math.min(parseInt(req.query.take) || 25, 100);
    const skip = parseInt(req.query.skip) || 0;
    const users = await prisma.user.findMany({ take, skip, orderBy: { createdAt: 'desc' } });
    res.json(users.map(sanitizeUser));
  } catch (e) { next(e); }
});

// Lightweight polling endpoint for frontend verification page (place BEFORE /:id route)
router.get('/verification-status', verificationStatusLimiter, async (req, res, next) => {
  try {
    const { username } = req.query;
  if (!username || typeof username !== 'string') throw badRequest('username required');
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.json({ exists: false, verified: false });
    res.json({ exists: true, verified: !!user.emailVerifiedAt });
  } catch (e) { next(e); }
});

// Get single user
router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) throw new AppError('Not found', 404);
    res.json(sanitizeUser(user));
  } catch (e) { next(e); }
});

// Update user (email, password)
router.patch('/:id', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const data = {};
    if (email !== undefined) {
      data.email = email;
      if (email) { // resetting verification on email change
        data.emailVerifiedAt = null;
        data.emailVerificationToken = generateVerificationToken();
        data.emailVerificationSentAt = new Date();
        try { await sendVerificationEmail({ to: email, token: data.emailVerificationToken }); } catch (e) { console.warn('[Email] send failure', e); }
      } else {
        data.emailVerifiedAt = null;
        data.emailVerificationToken = null;
        data.emailVerificationSentAt = null;
      }
    }
    if (password) data.passwordHash = await hashPassword(password);
  if (Object.keys(data).length === 0) throw badRequest('No updatable fields');
    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json(sanitizeUser(user));
  } catch (e) { next(e); }
});

// Delete user
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

// Basic login (returns user if password matches) - now enforces email verification
router.post('/login', async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    const identifier = username || email;
  if (!identifier || !password) throw badRequest('identifier and password required');

    // Determine lookup field - prefer username if supplied explicitly, else email if contains '@'
    let user = null;
    if (username) {
      user = await prisma.user.findUnique({ where: { username } });
    } else if (email) {
      user = await prisma.user.findUnique({ where: { email } });
    } else if (identifier.includes && identifier.includes('@')) {
      user = await prisma.user.findUnique({ where: { email: identifier } });
    } else {
      user = await prisma.user.findUnique({ where: { username: identifier } });
    }

    // Uniform error to avoid leaking which field failed
  if (!user) throw unauthorized('Invalid credentials');
    const valid = await comparePassword(password, user.passwordHash);
  if (!valid) throw unauthorized('Invalid credentials');
    if (user.email && !user.emailVerifiedAt) throw forbidden('Email not verified');
    const token = signUser(user);
    res.json({ user: sanitizeUser(user), token });
  } catch (e) { next(e); }
});


export default router;
