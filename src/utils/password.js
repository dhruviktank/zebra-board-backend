import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export async function hashPassword(plain) {
  if (!plain || plain.length < 6) throw new Error('Password must be at least 6 characters');
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
