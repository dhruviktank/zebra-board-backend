import { Router } from 'express';
import { prisma } from '../prismaClient.js';

const router = Router();

function sanitize(result) {
  if (!result) return null;
  if (result.user) {
    const { passwordHash, ...safeUser } = result.user;
    result.user = safeUser;
  }
  return result;
}

// Create a test result
router.post('/', async (req, res, next) => {
  try {
    const { userId, wpm, accuracy, rawWpm, characters, durationSec, mode } = req.body;
    if (wpm == null || accuracy == null) return res.status(400).json({ error: 'wpm and accuracy required' });
    const created = await prisma.testResult.create({
      data: { userId, wpm: Number(wpm), accuracy: Number(accuracy), rawWpm, characters, durationSec, mode }
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// List test results (with optional user filter & pagination)
router.get('/', async (req, res, next) => {
  try {
    const { userId } = req.query;
    const take = Math.min(parseInt(req.query.take) || 25, 100);
    const skip = parseInt(req.query.skip) || 0;
    const where = {};
    if (userId) where.userId = userId;
    const results = await prisma.testResult.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { user: true }
    });
    res.json(results.map(r => sanitize(r)));
  } catch (e) { next(e); }
});

// Get single test result
router.get('/:id', async (req, res, next) => {
  try {
    const result = await prisma.testResult.findUnique({ where: { id: req.params.id }, include: { user: true } });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(sanitize(result));
  } catch (e) { next(e); }
});

// Update test result (limited fields)
router.patch('/:id', async (req, res, next) => {
  try {
    const { wpm, accuracy, rawWpm, characters, durationSec, mode } = req.body;
    const data = {};
    if (wpm !== undefined) data.wpm = Number(wpm);
    if (accuracy !== undefined) data.accuracy = Number(accuracy);
    if (rawWpm !== undefined) data.rawWpm = rawWpm;
    if (characters !== undefined) data.characters = characters;
    if (durationSec !== undefined) data.durationSec = durationSec;
    if (mode !== undefined) data.mode = mode;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No updatable fields' });
    const updated = await prisma.testResult.update({ where: { id: req.params.id }, data, include: { user: true } });
    res.json(sanitize(updated));
  } catch (e) { next(e); }
});

// Delete test result
router.delete('/:id', async (req, res, next) => {
  try {
    await prisma.testResult.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
