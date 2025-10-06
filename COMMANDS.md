# Backend & Prisma Command Reference

A practical cheat sheet for the Zebra Board backend (Express + Prisma + PostgreSQL). All commands are intended to be run from the `zebra-board-backend` directory unless otherwise noted.

---
## 1. Environment & Setup

```bash
# Install dependencies
npm install

# Copy environment template
copy .env.example .env  # (Windows cmd / PowerShell)

# Edit .env and set real database URL
# Example:
# DATABASE_URL="postgresql://postgres:password@localhost:5432/zebraboard?schema=public"
# CORS_ORIGIN="http://localhost:5173"   # Frontend dev origin
```

Optional PowerShell execution policy (if npm scripts blocked):
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---
## 2. Development Server
```bash
# Start dev server with autoreload (nodemon)
npm run dev

# Health check (new terminal)
curl http://localhost:4000/health
```

---
## 3. Prisma Basics
```bash
# Generate Prisma Client (after schema edits)
npm run prisma:generate

# Create & apply a migration (interactive for dev DB)
npm run prisma:migrate --name init

# Open Prisma Studio (DB UI)
npm run prisma:studio

# Pull existing database schema into schema.prisma (if changed remotely)
npx prisma db pull

# Push local schema directly WITHOUT migrations (not recommended for prod)
npx prisma db push
```

Frontend (Vite) should point at backend:
```
VITE_API_BASE_URL=http://localhost:4000
```

---
## 4. Updating the Data Model
```bash
# 1. Edit prisma/schema.prisma
# 2. Create a new migration
npm run prisma:migrate --name add_field_x
# 3. Regenerate client (optional if migration ran)
npm run prisma:generate
```

Example (added passwordHash to User):
```bash
# After adding `passwordHash String` to User model
npm run prisma:migrate --name add_user_password_hash
npm run prisma:generate
```

---
## 5. Drift / Missing Migration Recovery
If you see: *"migration(s) applied to the database but missing locally"*

Reconstruct missing initial migration:
```bash
# Create folder for lost migration (replace TIMESTAMP)
mkdir prisma/migrations/20251005100522_init

# Rebuild SQL from live schema	npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20251005100522_init/migration.sql

# Check status
npx prisma migrate status
```

Reset dev DB instead (DATA LOSS):
```bash
npx prisma migrate reset
```

Mark as applied (placeholder; not ideal):
```bash
npx prisma migrate resolve --applied 20251005100522_init
```

---
## 6. Seeding (Future Pattern)
Add script in `package.json`:
```json
"prisma:seed": "node scripts/seed.js"
```
Example seed file (`scripts/seed.js`):
```js
import { prisma } from '../src/prismaClient.js';

async function main() {
  const user = await prisma.user.upsert({
    where: { username: 'demo' },
    update: {},
    create: { username: 'demo', email: 'demo@example.com' }
  });
  await prisma.testResult.create({
    data: { wpm: 80, accuracy: 96.5, mode: 'time', durationSec: 60, userId: user.id }
  });
  console.log('Seed complete');
}

main().catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
```
Run:
```bash
npx prisma db seed
```

---
## 7. Useful Database Commands (psql)
```bash
# Connect to local Postgres
psql -h localhost -U postgres -d zebraboard

# List tables
\dt

# Describe a table
\d "TestResult"

# Quit
\q
```

---
## 8. Quick cURL Examples
```bash
# Get health
curl http://localhost:4000/health

# Create user
curl -X POST http://localhost:4000/users -H "Content-Type: application/json" -d '{"username":"demo","password":"secret123","email":"demo@example.com"}'

# User login (basic, no token yet)
curl -X POST http://localhost:4000/users/login -H "Content-Type: application/json" -d '{"username":"demo","password":"secret123"}'

# List users (paginated)
curl http://localhost:4000/users?take=10

# Create test result (associate with userId if known)
curl -X POST http://localhost:4000/test-results -H "Content-Type: application/json" -d '{"userId":"<USER_ID>","wpm":85,"accuracy":97.2,"mode":"time","durationSec":60}'

# List test results
curl http://localhost:4000/test-results?take=5

# Filter test results by userId
curl "http://localhost:4000/test-results?userId=<USER_ID>"
```

---
## 9. OAuth + JWT Authentication

### 9.1 Environment Variables
Add these to `.env` (values are examples):
```
FRONTEND_BASE_URL=http://localhost:5173
OAUTH_CALLBACK_URL=http://localhost:4000
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID=YOUR_GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET
JWT_SECRET=replace_me_with_long_random
JWT_EXPIRES=15m
SESSION_SECRET=dev-session
```

### 9.2 Flow Overview
1. User clicks Google/GitHub button in frontend (`/auth/<provider>?redirect=/profile`).
2. Passport OAuth flow executes; on success backend creates/updates user.
3. Backend signs short-lived JWT and redirects browser to
   `FRONTEND_BASE_URL/oauth/callback#token=<JWT>`.
4. Frontend callback page parses `#token`, stores it (localStorage), calls `/auth/me`.
5. `/auth/me` verifies token (Authorization: Bearer) and returns sanitized user object.
6. App considers user logged in; API calls now include Authorization header automatically.

### 9.3 Endpoints
```
GET /auth/google           # begin Google OAuth
GET /auth/google/callback  # internal redirect target
GET /auth/github           # begin GitHub OAuth
GET /auth/github/callback  # internal redirect target
GET /auth/me               # returns current user (requires Bearer token)
```

### 9.4 Test with cURL (after obtaining a token)
```bash
# Assume TOKEN variable contains JWT
curl -H "Authorization: Bearer %TOKEN%" http://localhost:4000/auth/me
```
(Windows CMD: `set TOKEN=...` then use `%TOKEN%`)

### 9.5 Adding Another Provider (Outline)
1. Install strategy package.
2. Configure in `passport.js` similar to Google/GitHub.
3. Add routes in `routes/auth.js`.
4. Ensure provider ID and secret in `.env`.
5. Update frontend button to call new provider route.

### 9.6 Token Expiry Handling
- Current access token expires (`JWT_EXPIRES`, default 15m).
- On expiry, protected calls return 401; frontend should clear token and prompt re-login.
- (Future) Add refresh token endpoint with httpOnly cookie or rotating refresh token table.

### 9.7 Security Notes
- Use a strong `JWT_SECRET` (>= 32 random bytes).
- Consider enabling CSRF/state verification: pass random `state` param stored locally and validate in callback before issuing token (Passport's state already echoes but custom validation can be added).
- Production: enforce HTTPS, secure cookie if using refresh tokens.
- Avoid logging full tokens.

---
## 10. Email Verification Flow

### 10.1 New Schema Fields
Added to `User`:
- `emailVerifiedAt DateTime?`
- `emailVerificationToken String? @unique`
- `emailVerificationSentAt DateTime?`

### 10.2 Registration
`POST /users` now returns:
```
{ pendingVerification: true, user: { ... } }  # when email provided
{ pendingVerification: false, user: { ... } } # when no email
```
If `pendingVerification` is true the frontend must show a "Check your inbox" message and NOT treat the user as logged in until verification.

### 10.3 Verification
Backend endpoint:
```
GET /auth/verify-email?token=<token>
```
On success: marks user verified and redirects to:
```
/login?verified=1&user=<username>
```

### 10.4 Login Enforcement
`POST /users/login` returns 403 `{ error: 'Email not verified' }` if a user has an email but `emailVerifiedAt` is null.

### 10.5 Token Generation & Expiry
- 32-byte random hex token.
- Expires after `EMAIL_VERIFICATION_EXPIRES_HOURS` (default 24h). Expired tokens return 400.

### 10.6 Resend (Future)
Add `POST /auth/resend-verification` with rate limiting (not implemented yet).

### 10.7 OAuth Users
On OAuth success, if email present it's auto-marked verified.

### 10.8 Environment Variables (Add to .env)
```
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM="Zebra Board <no-reply@zebraboard.local>"
FRONTEND_VERIFY_URL=http://localhost:5173/verify-email
EMAIL_VERIFICATION_EXPIRES_HOURS=24
```
If SMTP variables are missing, emails are logged to console as a mock.

---
## 11. Troubleshooting (Updated)
| Symptom | Fix |
|---------|-----|
| 403 Email not verified | Click link in verification email, ensure token valid |
| Token expired | Register again or add resend endpoint |
| SMTP auth failed | Check SMTP_HOST/USER/PASS and port/secure correctness |
| Verification link 404 | Ensure `/auth/verify-email` route and token intact (no extra punctuation) |

---
## 12. Safe Workflow Checklist
1. Edit `prisma/schema.prisma`
2. Run: `npm run prisma:migrate --name meaningful_change`
3. (Optional) `npm run prisma:generate`
4. Commit: schema + new migration folder
5. Deploy migration to other env with: `prisma migrate deploy` (CI/CD)
6. Verify: `npx prisma migrate status`

---
## 13. Future Enhancements (Ideas)
- Add rate limiting middleware
- Add refresh tokens & rotation
- Add request validation (Zod)
- Implement seeding strategy per environment
- Add per-user settings/preferences model
- Add resend verification endpoint
- Add refreshable sessions with httpOnly cookie

---
Keep this file updated whenever you add new scripts or workflow steps.
