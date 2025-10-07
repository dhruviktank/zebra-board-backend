import { Router } from 'express';
import { prisma } from '../prismaClient.js';
import { authMiddleware } from '../auth/jwt.js';

const router = Router();

// Create a suggestion
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    let { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }
    message = message.trim();
    if (message.length > 2000) return res.status(400).json({ error: 'message too long' });
    const created = await prisma.suggestion.create({ data: { message, userId: req.user.id } });
    res.status(201).json({ id: created.id, createdAt: created.createdAt });
  } catch (e) { next(e); }
});

export default router;