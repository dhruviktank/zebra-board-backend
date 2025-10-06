import 'dotenv/config';
// Basic Express server with Prisma integration placeholder
import express from 'express';
import { prisma } from './prismaClient.js';
import session from 'express-session';
import { passport } from './auth/passport.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import testResultsRouter from './routes/testResults.js';
import { notFound, errorHandler } from './middleware/errors.js';
import cors from 'cors';
const app = express();

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
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-session', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
console.log('CORS allowed origins:', allowedOrigins);

app.get('/health', (req, res) => { res.json({ status: 'ok' }); });

app.use('/users', usersRouter);
app.use('/test-results', testResultsRouter);
app.use('/auth', authRouter);

// Generic 404 -> forward to error middleware
app.use((req, res, next) => { next(notFound()); });

// Central error handler
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
	console.log(`API listening on :${PORT}`);
});
