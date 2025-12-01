# Attendance System - AI Agent Instructions

## Architecture Overview

This is a **monolithic Node.js/Express attendance tracking system** with SQLite database, role-based access control, and mobile-first UI. The entire backend logic lives in `index.js` (~1820 lines).

### Key Components
- **Single-file backend**: `index.js` - all routes, database setup, middleware, and business logic
- **Static HTML pages**: `login.html`, `dashboard.html`, `admin.html`, `appsettings.html`, `profile.html`, `visual.html`
- **Shared UI utilities**: `/public/js/ui.js` - reusable modal/confirm dialogs
- **Mobile-first CSS**: `/public/css/mobile.css` - forces mobile layout (max-width 420px) on all screens
- **Database**: SQLite (`attendance.db`) with per-user attendance tables + shared leaves/settings tables

### User Roles & Access
- **owner**: Full system access (Smita) - manages settings, users, leaves, test dates
- **manager**: Can approve/reject leaves, view all attendance (Dinesh)
- **employee**: Mark attendance, apply for leaves, view own records

Middleware: `requireLogin`, `requireAdmin` (owner/manager), `requireOwner` (owner only)

## Database Schema

**Tables created at startup:**
- `users`: name (PK), password (bcrypt), role, leave_balance, leave_balance_last_updated, join_date, current_session_id
- `attendance_{username}`: date (PK), in_time, in_latitude, in_longitude, in_selfie_path, out_time, out_latitude, out_longitude, out_selfie_path (one table per non-owner user)
- `leaves`: leave_id (PK), username, start_date, end_date, reason, status, approved_by, is_backdated, taken_back, taken_back_at
- `settings`: name (PK), value (stores desktop_enabled, test_date_override, weekly_off_mode, etc.)
- `ad_hoc_offs`: id (PK), date, reason, created_by, created_at (owner-declared specific days off)
- `holidays`: id (PK), name, month_day, date (recurring yearly holidays)

**Schema migrations**: Tables use `CREATE TABLE IF NOT EXISTS`. Missing columns are added via runtime `PRAGMA table_info` checks followed by `ALTER TABLE ADD COLUMN` (see lines ~100-135 in `index.js`).

## Critical Developer Workflows

### Running the App
```powershell
# Install dependencies
npm install

# Start HTTPS server (requires 192.168.1.9+1-key.pem and 192.168.1.9+1.pem in root)
npm start  # or node index.js
```
Server listens on `https://0.0.0.0:3000` (accessible by IP for mobile testing).

**Default users** (password: "111" for all):
- smita (owner), dinesh (manager), manuj/atul/kamini/nazmul (employees)

### Key Routes Pattern
- **Public**: `/`, `/login`, `/logout`
- **Employee**: `/dashboard`, `/profile`, `/attendance`, `/leaves`, `/visual` (+ requireLogin)
- **Admin**: `/admin`, `/admin/users`, `/admin/attendance/:username`, `/admin/leaves` (+ requireAdmin)
- **Owner**: `/appsettings`, `/admin/settings/app`, `/admin/settings/test-date` (+ requireOwner)

## Project-Specific Conventions

### Date Testing System
The app supports **date overrides** for testing without system clock changes:
1. **Global override** (owner-set via `/appsettings`): stored in `settings.test_date_override`, loaded into `app.locals.testDateOverride` at startup
2. **Per-request override**: query param `?test_date=YYYY-MM-DD`, header `x-test-date`, cookie `test_date`, or session `testDate`

**Priority**: Global override > query param > header > cookie > session > system date

Function: `getEffectiveDate(req)` returns the effective date string (YYYY-MM-DD). Used throughout for attendance marking, leave calculations, and visual calendar.

### Leave Balance System
- Employees accrue **2 leaves per month** starting from `join_date`
- Accrual runs **on server startup** (`accrueLeavesForUserOnStartup`) for all employees
- Balance stored in `users.leave_balance`, last accrual month in `leave_balance_last_updated`
- Leaves can be "taken back" (status reset to pending, balance refunded) if `taken_back=1`

### Session Management
- **Single-session enforcement**: `users.current_session_id` tracks the active session ID. When a user logs in, the new session ID is stored, and old sessions are invalidated.
- `requireLogin` middleware checks if `req.sessionID` matches `current_session_id` in DB. Mismatch → session destroyed, redirect to login with `?session_invalidated=1`.

### Mobile-First UI
- **All pages force mobile layout** via `mobile.css`: `--container-max-width: 420px` applied to `.container`
- Desktop access can be **disabled by owner** via `settings.desktop_enabled` flag (checked at login)
- Shared modal/confirm system in `/js/ui.js` (`showAppModal`, `showAppConfirm`) used by all pages

### Selfie & Geolocation Tracking
- Attendance mark-in/mark-out include **selfies** (base64 → file saved to `./selfies/{username}/{timestamp}.jpg`) and **GPS coordinates**
- Selfie paths stored in `attendance_{username}.in_selfie_path` and `out_selfie_path`
- Served via `/selfies` static route

## Common Patterns

### Error Handling
- JSON APIs return `{ success: boolean, message: string, ... }`
- HTML endpoints redirect or serve `404.html` / `500.html`
- DB errors logged to console, graceful fallback (e.g., `requireLogin` fail-open on DB errors)

### Password Management
- Passwords hashed with `bcryptjs` (SALT_ROUNDS=10)
- Change password: `/user/change-password` (requires old password verification)
- Admin reset: `/admin/users/reset-password` (admin-only, no old password needed)

### Date Formatting
- **Storage**: `YYYY-MM-DD` (SQLite TEXT)
- **Display**: `moment().format('D-MMM-YY')` (e.g., "6-Dec-25") via `formatDateForDisplay()`
- **Time display**: `moment().format('h:mm A')` via `formatTimeForDisplay()`

## Adding New Features

**New routes**: Add in `index.js` after existing routes, before 404 handler (line ~1765).

**New DB columns**: Add runtime migration in `db.serialize()` block using `PRAGMA table_info` check (see `leaves` table migrations lines ~125-135).

**New HTML pages**: Create in root, reference `/css/mobile.css`, `/js/ui.js`. Add navigation links in relevant pages (dashboard/admin).

**New settings**: Insert into `settings` table in `db.serialize()` block, access via `db.get("SELECT value FROM settings WHERE name = ?", ...)`

## Critical Workflows Deep-Dive

### Leave Application & Approval Flow
**Employee applies leave** (`POST /leaves/apply`):
1. Validates date range (start ≤ end, proper format)
2. **Blocks leave if attendance already marked** for any date in range
3. **Blocks leave on off-days** (ad-hoc/holiday/weekly) - prevents gaming the system
4. Checks for overlapping pending/approved leaves
5. Verifies sufficient balance (doesn't deduct yet)
6. Sets `is_backdated=1` if start_date < `getEffectiveDate(req)`
7. Inserts with `status='pending'`

**Admin approves/rejects** (`POST /admin/leaves/action`):
- **Race condition protection**: rejects if `status != 'pending'` (already processed)
- **Permission checks**: 
  - Managers can only approve employee leaves
  - Only owner can approve manager leaves
- **Balance deduction happens here** on approval (not during application)
- Rejects if leave was `taken_back=1` (withdrawn)

**Employee withdraws** (`POST /leaves/takeback`):
- Sets `taken_back=1`, `status='withdrawn'`, records timestamp
- Only works for `status='pending'` leaves
- Balance is NOT refunded (prevents abuse of approved leaves)

### Visual Calendar Data Flow
**Route**: `GET /visual/data?username=X&year=Y&month=M`

**Authorization logic**:
- Employees can ONLY view their own calendar
- Managers/owner can view any employee calendar
- Owner accounts are hidden (404) - they don't have attendance tables

**Data aggregation** (all parallel DB queries):
1. Fetch attendance rows for month
2. Fetch approved leaves overlapping month
3. Fetch ad-hoc offs for month
4. Fetch all holidays (both full-date and recurring MM-DD)
5. Fetch weekly_off_mode setting

**Status priority** (per day):
1. Ad-hoc off → `status='ad_hoc'`
2. Full-date holiday → `status='holiday'`
3. Recurring holiday (MM-DD match) → `status='holiday'`
4. Weekly off (mode-dependent) → `status='weekly'`
5. If NOT an off-day:
   - Approved leave covering date → `status='leave'`
   - Attendance record exists → `status='present'`
   - Otherwise → `status='absent'`

### Off-Day Detection (`checkIfDateIsOff`)
**Cascading checks** (sequential, short-circuits on first match):
1. Ad-hoc offs table (specific YYYY-MM-DD)
2. Holidays table - full date match
3. Holidays table - MM-DD recurring match
4. Weekly off calculation based on mode:
   - **Mode 1**: All Sundays
   - **Mode 2**: All Sundays + All Saturdays
   - **Mode 3**: All Sundays + 2nd/4th Saturdays
   - **Mode 4**: All Sundays + 1st/3rd/5th Saturdays

Used to **block attendance marking** on off-days and validate leave applications.

### Attendance Marking with Geofencing
**Mark-in** (`POST /mark-in`):
- Captures: selfie (base64→file), GPS coords, timestamp
- **Blocks if already marked in** for the date
- **Blocks non-owners on off-days** (owner can mark any day)
- File saved: `./selfies/{username}/{username}_{date}_{time}_in.jpg`

**Mark-out** (`POST /mark-out`):
- Requires existing mark-in with no mark-out
- Updates same row with out_time, out_coords, out_selfie

### Desktop Access Control
**Enforcement** (`enforceDeviceAccess` middleware):
- Runs BEFORE all protected routes (after session setup)
- Owner always bypassed
- Checks `settings.desktop_enabled` flag
- Device detection: cookie `device_type` (preferred) or UA sniffing
- If disabled + desktop device → destroys session, redirects with `?desktop_blocked=1`
- Blocks at login too (checks setting before creating session)

## Common Pitfalls & Debugging

### Database Issues
**Problem**: "no such column" errors after updates
- **Fix**: Schema migrations run at startup via PRAGMA checks (lines ~100-135)
- Check startup logs for migration confirmation
- Delete `attendance.db` to rebuild from scratch (loses data!)

**Problem**: Attendance not showing for user
- **Check**: `attendance_{username}` table exists (created only for non-owner users)
- Owner role users have NO attendance table by design

### Session Invalidation
**Problem**: Users logged out unexpectedly
- **Cause**: Single-session enforcement - new login invalidates old session
- `users.current_session_id` must match `req.sessionID`
- Check for `?session_invalidated=1` in URL (friendly message trigger)

**Problem**: requireLogin fails silently
- **Behavior**: Middleware fails-open on DB errors (prevents lockout)
- Check console for "Error verifying session id" messages

### Date Testing
**Problem**: Test date not working
- **Priority order**: Global override > query param > header > cookie > session > real date
- Check startup log: "Loaded test_date_override: {value}"
- Global override set via `/appsettings` persists in `settings` table
- Use `?test_date=YYYY-MM-DD` for per-request testing

**Problem**: Leave backdated flag incorrect
- Uses `getEffectiveDate(req)` not `moment()` - respects test dates

### Leave Balance Confusion
**Key**: Balance is NOT deducted when leave is applied
- Deduction happens on admin approval (`/admin/leaves/action`)
- Accrual runs ONLY at server startup (not runtime)
- Check logs: "Accrued X leaves for {user}. New balance: Y"

### Visual Calendar Empty/Wrong
**Common causes**:
1. Requesting owner's calendar (returns 404 - no attendance table)
2. Employee requesting another user (403 - not authorized)
3. Wrong table name - username validation: `^[A-Za-z0-9_]+$` only

### HTTPS Certificate Errors
**Problem**: Server won't start
- **Required files**: `192.168.1.9+1-key.pem` and `192.168.1.9+1.pem` in project root
- Generate with mkcert or similar for local network testing
- Server listens on `0.0.0.0:3000` for mobile device access

### bcrypt Password Hashing Failures
**Symptom**: Login fails for seed users
- Check startup logs for "Error hashing seed password"
- Falls back to plaintext storage on hash failure (security risk!)
- Default password for all seed users: "111"

## Performance & Optimization Patterns

### Parallel DB Queries
Visual calendar uses `Promise.all()` to batch 5 queries:
```javascript
const [attendance, leaves, adhoc, holidays, weeklyMode] = await Promise.all([...])
```
**Pattern**: Use for independent read-only queries to reduce latency.

### Per-User Attendance Tables
- Avoids large table scans (each employee has `attendance_{username}`)
- **Tradeoff**: Dynamic table creation, SQL injection risk (mitigated by username validation)
- Admin attendance view requires explicit table name in query

### Selfie Storage
- Base64 decoded and written to filesystem (not DB)
- Served via static route `/selfies`
- **Cleanup**: No automatic deletion - orphaned files accumulate

## Testing Procedures

### Manual Testing Workflow
```powershell
# Start server
npm start

# Access from mobile device on same network
# https://192.168.1.9:3000

# Test date override (simulate future/past)
https://192.168.1.9:3000/dashboard?test_date=2025-12-25

# Owner sets global test date
# Navigate to /appsettings, set date, affects entire system
```

### Test User Credentials
All passwords: "111"
- **smita** (owner) - full access, no attendance table
- **dinesh** (manager) - can mark attendance, approve employee leaves
- **manuj/atul/kamini/nazmul** (employees) - standard access

### Verify Leave Accrual
Check startup logs for each employee:
```
Accrued {X} leaves for {username}. New balance: {Y}
Initial leave accrual on startup completed.
```

### Debugging Routes
- `GET /user/me` - returns current session user (JSON)
- `GET /leaves/balance` - returns leave balance for logged-in user
- `GET /admin/settings/app` - returns desktop_enabled, weekly_off_mode, holidays (owner only)
