import rateLimit from 'express-rate-limit';

// General helper to create a limiter
function createLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests, please try again later.' }
  });
}

export const registerLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: 'Too many registrations from this IP, please try again later.'
});

export const verifyEmailLimiter = createLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: 'Too many verification attempts, please slow down.'
});

export const verificationStatusLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 60, // 1 req/sec average
  message: 'Polling too frequently.'
});

export const resendVerificationLimiter = createLimiter({
  windowMs: 30 * 60 * 1000, // 30 min
  max: 3,
  message: 'Too many resend attempts, wait before trying again.'
});
