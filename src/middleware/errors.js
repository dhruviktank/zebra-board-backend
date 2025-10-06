export class AppError extends Error {
  constructor(message, status = 500, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

export function notFound(message = 'Not found') {
  return new AppError(message, 404, 'NOT_FOUND');
}

export function badRequest(message = 'Bad request') {
  return new AppError(message, 400, 'BAD_REQUEST');
}

export function unauthorized(message = 'Unauthorized') {
  return new AppError(message, 401, 'UNAUTHORIZED');
}

export function forbidden(message = 'Forbidden') {
  return new AppError(message, 403, 'FORBIDDEN');
}

export function conflict(message = 'Conflict') {
  return new AppError(message, 409, 'CONFLICT');
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Known AppError
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  // Prisma unique constraint
  if (err && err.code === 'P2002') {
    return res.status(409).json({ error: 'Conflict: unique constraint failed', code: 'UNIQUE_CONSTRAINT' });
  }
  console.error('[UnhandledError]', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
}
