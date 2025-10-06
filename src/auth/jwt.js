import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '15m';

export function signUser(user) {
  const payload = { id: user.id, username: user.username, provider: user.provider };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}