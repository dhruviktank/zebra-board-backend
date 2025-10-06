import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { prisma } from '../prismaClient.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const CALLBACK_BASE = process.env.OAUTH_CALLBACK_URL || 'http://localhost:4000';

async function upsertOAuthUser(provider, providerId, profile) {
  // Try find by providerId first
  let user = await prisma.user.findUnique({ where: { providerId } });
  if (!user) {
    // Derive username fallback
    const baseUsername = (profile.username || profile.displayName || profile.emails?.[0]?.value || `${provider}_${providerId}`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
    let username = baseUsername || `${provider}_${providerId}`;
    // Ensure uniqueness
    let counter = 1;
    while (await prisma.user.findUnique({ where: { username } })) {
      username = `${baseUsername}_${counter++}`.slice(0, 30);
    }
    user = await prisma.user.create({
      data: {
        username,
        email: profile.emails?.[0]?.value,
        provider,
        providerId,
      }
    });
  }
  return user;
}

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: `${CALLBACK_BASE}/auth/google/callback`,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const user = await upsertOAuthUser('google', profile.id, profile);
      done(null, user);
    } catch (e) { done(e); }
  }));
  console.log('[Auth] Google strategy registered');
} else {
  console.warn('[Auth] Google strategy NOT registered (missing GOOGLE_CLIENT_ID/SECRET)');
}

if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    callbackURL: `${CALLBACK_BASE}/auth/github/callback`,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const user = await upsertOAuthUser('github', profile.id, profile);
      done(null, user);
    } catch (e) { done(e); }
  }));
  console.log('[Auth] GitHub strategy registered');
} else {
  console.warn('[Auth] GitHub strategy NOT registered (missing GITHUB_CLIENT_ID/SECRET)');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (e) { done(e); }
});

export { passport };