import 'dotenv/config';
// Basic Express server with Prisma integration placeholder
import express from 'express';
import { prisma } from './prismaClient.js';
import session from 'express-session';
import pg from 'pg';
import connectPg from 'connect-pg-simple';
import { passport } from './auth/passport.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import testResultsRouter from './routes/testResults.js';
import suggestionsRouter from './routes/suggestions.js';
import { notFound, errorHandler } from './middleware/errors.js';
import cors from 'cors';
const app = express();

// Behind Railway / reverse proxies we need to trust the first proxy so that
// express-rate-limit and other middleware can read X-Forwarded-* headers safely.
// Set via env override if needed: TRUST_PROXY=0 to disable.
const trustProxy = process.env.TRUST_PROXY !== '0';
if (trustProxy) {
	// '1' trusts first proxy hop (sufficient for most PaaS like Railway / Render / Fly)
	app.set('trust proxy', 1);
	console.log('Trust proxy enabled (1)');
} else {
	console.log('Trust proxy disabled via TRUST_PROXY env');
}

// CORS configuration: supports comma-separated origins in CORS_ORIGIN
const rawOrigins = process.env.CORS_ORIGIN || 'http://localhost:5173';
const allowedOrigins = rawOrigins.split(',').map(o => o.trim()).filter(Boolean);

const corsOptions = {
	origin: (origin, callback) => {
		if (!origin) return callback(null, true); // non-browser or same-origin
		if (allowedOrigins.includes(origin)) return callback(null, true);
		return callback(new Error('CORS not allowed for origin: ' + origin));
	},
	credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());
// Minimal session just to satisfy passport's serialize/deserialize (OAuth flow). JWT used for API auth.
// Postgres session store (production safe)
const PgSession = connectPg(session);
const pgPool = new pg.Pool({
	connectionString: process.env.DATABASE_URL,
	// Add ssl config if your provider requires: ssl: { rejectUnauthorized: false }
});

app.use(session({
	store: new PgSession({
		pool: pgPool,
		tableName: 'session',
		createTableIfMissing: true,
		pruneSessionInterval: 60 // seconds (default). Adjust via env if needed.
	}),
	name: process.env.SESSION_COOKIE_NAME || 'sid',
	secret: process.env.SESSION_SECRET || 'dev-session',
	resave: false,
	saveUninitialized: false,
	cookie: {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: (parseInt(process.env.SESSION_MAX_AGE_DAYS || '7', 10)) * 24 * 60 * 60 * 1000
	}
}));
app.use(passport.initialize());
app.use(passport.session());
console.log('CORS allowed origins:', allowedOrigins);

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });

app.use('/users', usersRouter);
app.use('/test-results', testResultsRouter);
app.use('/auth', authRouter);
app.use('/suggestions', suggestionsRouter);

// Generic 404 -> forward to error middleware
app.use((req, res, next) => { next(notFound()); });

// Central error handler
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
	console.log(`API listening on :${PORT}`);
});

// Periodic DB ping to surface closed/idle connections early (option B)
const PRISMA_PING_INTERVAL_MS = parseInt(process.env.PRISMA_PING_INTERVAL_MS || '180000', 10);
setInterval(async () => {
	try {
		await prisma.$queryRaw`SELECT 1`;
	} catch (e) {
		console.warn('[DB Health] Ping failed:', e.message || e);
	}
}, PRISMA_PING_INTERVAL_MS).unref();

// Graceful shutdown & diagnostics
const shutdownSignals = ['SIGTERM', 'SIGINT'];
shutdownSignals.forEach(sig => {
	process.on(sig, () => {
		console.warn(`[Shutdown] Received ${sig}, starting graceful shutdown`);
		// Close HTTP server
		server.close(err => {
			if (err) {
				console.error('[Shutdown] Error closing server', err);
				process.exitCode = 1;
			}
			// Attempt to end prisma + pg pool if present
			Promise.resolve()
				.then(async () => { try { await prisma.$disconnect(); console.log('[Shutdown] Prisma disconnected'); } catch (e) { console.warn('[Shutdown] Prisma disconnect error', e); } })
				.then(() => { try { if (global.gc) global.gc(); } catch {} })
				.finally(() => {
					console.log('[Shutdown] Complete – exiting');
					process.exit();
				});
		});
		// Failsafe timeout
		setTimeout(() => {
			console.error('[Shutdown] Force exit after timeout');
			process.exit(1);
		}, 10000).unref();
	});
});

process.on('uncaughtException', err => {
	console.error('[Fatal] Uncaught exception', err);
	process.exit(1);
});
process.on('unhandledRejection', err => {
	console.error('[Fatal] Unhandled rejection', err);
});
