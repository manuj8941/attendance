const express = require( 'express' );
const sqlite3 = require( 'sqlite3' ).verbose();
const path = require( 'path' );
const session = require( 'express-session' );
const fs = require( 'fs' );
const moment = require( 'moment' );
const bcrypt = require( 'bcryptjs' );
const SALT_ROUNDS = 10;

const app = express();
const port = 3000;

// --- DIRECTORY AND USER SETUP ---
const selfiesDir = './selfies';
if ( !fs.existsSync( selfiesDir ) )
{
    fs.mkdirSync( selfiesDir );
}

const users = [
    { name: 'smita', password: '111', role: 'owner' },
    { name: 'dinesh', password: '111', role: 'manager' },
    { name: 'manuj', password: '111', role: 'employee' },
    { name: 'atul', password: '111', role: 'employee' },
    { name: 'kamini', password: '111', role: 'employee' },
    { name: 'nazmul', password: '111', role: 'employee' }
];

users.forEach( user =>
{
    const userSelfieDir = path.join( selfiesDir, user.name );
    if ( !fs.existsSync( userSelfieDir ) )
    {
        fs.mkdirSync( userSelfieDir );
    }
} );

// --- MIDDLEWARE ---
app.use( session( {
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true
} ) );
app.use( express.urlencoded( { extended: true, limit: '50mb' } ) );
app.use( express.json( { limit: '50mb' } ) );
app.use( '/selfies', express.static( 'selfies' ) );
// Serve public assets (CSS, JS) including mobile stylesheet
app.use( express.static( 'public' ) );

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database( './attendance.db', ( err ) =>
{
    if ( err )
    {
        console.error( err.message );
    }
    console.log( 'Connected to the attendance database.' );
} );

db.serialize( () =>
{
    // Users table with roles, leave balance, last update timestamp, and join date
    db.run( 'CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password TEXT, role TEXT, leave_balance REAL DEFAULT 0, leave_balance_last_updated TEXT, join_date TEXT DEFAULT \'2025-01-01\')', ( err ) =>
    {
        if ( err )
        {
            console.error( "Error creating users table", err.message );
            return;
        }
        // Schema is managed centrally; no runtime ALTER/UPDATE migrations required here.
    } );

    const stmtUsers = db.prepare( 'INSERT OR IGNORE INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)' );
    users.forEach( user =>
    {
        try
        {
            const pwdHash = bcrypt.hashSync( ( user.password || '' ).toString(), SALT_ROUNDS );
            stmtUsers.run( user.name, pwdHash, user.role, '2025-01-01' ); // Default join_date for all users
        } catch ( e )
        {
            console.error( 'Error hashing seed password for', user.name, e );
            stmtUsers.run( user.name, user.password, user.role, '2025-01-01' );
        }
    } );
    stmtUsers.finalize();

    // Ensure optional column exists on `users` for single-session mapping (current_session_id)
    db.all( "PRAGMA table_info(users)", [], ( prErrU, ucols ) =>
    {
        if ( prErrU ) return; // cannot verify, skip safely
        try
        {
            const namesU = ( ucols || [] ).map( c => c.name );
            if ( namesU.indexOf( 'current_session_id' ) === -1 ) db.run( "ALTER TABLE users ADD COLUMN current_session_id TEXT DEFAULT ''" );
        } catch ( e ) { /* ignore migration errors */ }
    } );

    // Attendance tables
    users.forEach( user =>
    {
        if ( user.role !== 'owner' )
        { // Owner admin does not mark attendance
            db.run( `CREATE TABLE IF NOT EXISTS attendance_${ user.name } (
                date TEXT PRIMARY KEY, 
                in_time TEXT, in_latitude REAL, in_longitude REAL, in_selfie_path TEXT,
                out_time TEXT, out_latitude REAL, out_longitude REAL, out_selfie_path TEXT
            )`);
        }
    } );

    // Leaves table
    db.run( `CREATE TABLE IF NOT EXISTS leaves (
        leave_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        start_date TEXT,
        end_date TEXT,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        approved_by TEXT
    )`);

    // Ensure optional columns exist on `leaves` for older databases.
    // This performs a safe PRAGMA check and only adds missing columns so existing DBs
    // that were created before these columns were introduced won't cause runtime SQL errors.
    db.all( "PRAGMA table_info(leaves)", [], ( prErr, cols ) =>
    {
        if ( prErr ) return; // cannot verify, skip safely
        try
        {
            const names = ( cols || [] ).map( c => c.name );
            if ( names.indexOf( 'is_backdated' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN is_backdated INTEGER DEFAULT 0" );
            if ( names.indexOf( 'taken_back' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN taken_back INTEGER DEFAULT 0" );
            if ( names.indexOf( 'taken_back_at' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN taken_back_at TEXT DEFAULT ''" );
        } catch ( e ) { /* ignore migration errors */ }
    } );

    // Settings table for simple app-wide flags (e.g. desktop access toggle)
    db.run( "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT)", ( err ) =>
    {
        if ( err ) console.error( 'Error creating settings table', err && err.message );
        else
        {
            // defaults: desktop access ON by default
            db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_enabled', '1' ] );
            db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_disabled_at', '' ] );
            // test_date_override is empty by default (no global override)
            db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'test_date_override', '' ] );
        }
    } );

    // Ad-hoc off days table (owner declares specific YYYY-MM-DD days off)
    db.run( `CREATE TABLE IF NOT EXISTS ad_hoc_offs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        reason TEXT,
        created_by TEXT,
        created_at TEXT
    )` );

    // Yearly holidays table (store month-day like '10-15' for recurring yearly celebrations)
    db.run( `CREATE TABLE IF NOT EXISTS holidays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        month_day TEXT,
        date TEXT
    )` );

    // Weekly off scheduling (1 default -> All Sundays off). Stored in settings as 'weekly_off_mode'
    db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'weekly_off_mode', '1' ] );

    // --- SERVER STARTUP LEAVE ACCRUAL ---
    db.all( 'SELECT name, join_date, leave_balance, leave_balance_last_updated FROM users WHERE role != ?', [ 'owner' ], async ( err, employees ) =>
    {
        if ( err )
        {
            console.error( 'Error fetching employees for startup accrual:', err.message );
            return;
        }
        for ( const employee of employees )
        {
            try
            {
                await accrueLeavesForUserOnStartup( employee );
            } catch ( error )
            {
                console.error( `Error during startup leave accrual for ${ employee.name }:`, error.message );
            }
        }
        console.log( 'Initial leave accrual on startup completed.' );
    } );
    // Load global test-date override into app local cache for fast access
    db.get( "SELECT value FROM settings WHERE name = ?", [ 'test_date_override' ], ( err, row ) =>
    {
        const val = ( row && row.value ) ? row.value : '';
        app.locals.testDateOverride = val;
        if ( val )
        {
            try
            {
                const m = moment( val, 'YYYY-MM-DD', true );
                const formatted = m.isValid() ? m.format( 'D-MMM-YY' ) : val;
                console.log( 'Loaded test_date_override:', formatted );
            } catch ( e )
            {
                console.log( 'Loaded test_date_override:', val );
            }
        } else
        {
            console.log( 'Loaded test_date_override: (none)' );
        }
    } );
} );

// --- HELPER FUNCTIONS ---

function formatTimeForDisplay ( date, time )
{
    if ( !date || !time ) return null;
    return moment( `${ date } ${ time }`, 'YYYY-MM-DD HH:mm:ss' ).format( 'h:mm A' );
}

function computeTotalTimeForRow ( row )
{
    if ( !row || !row.in_time ) return null;
    try
    {
        const inMoment = moment( `${ row.date } ${ row.in_time }`, 'YYYY-MM-DD HH:mm:ss' );
        const outMoment = row.out_time ? moment( `${ row.date } ${ row.out_time }`, 'YYYY-MM-DD HH:mm:ss' ) : moment();
        const diff = moment.duration( outMoment.diff( inMoment ) );
        if ( diff.asMilliseconds() <= 0 ) return null;
        const hours = Math.floor( diff.asHours() );
        const minutes = diff.minutes();
        return `${ hours }h ${ minutes }m`;
    } catch ( e )
    {
        return null;
    }
}

function formatDateForDisplay ( date )
{
    if ( !date ) return null;
    // Compact date for tables: e.g. 6-Dec-25
    return moment( date, 'YYYY-MM-DD' ).format( 'D-MMM-YY' );
}

// Helper: return an effective 'today' (YYYY-MM-DD) for the request.
// Priority: query param `test_date`, header `x-test-date`, cookie `test_date`, session.testDate, system date.
function getEffectiveDate ( req )
{
    try
    {
        // 0) global app-wide override (owner-set permanent test date)
        if ( req && req.app && req.app.locals && req.app.locals.testDateOverride )
        {
            const m = moment( req.app.locals.testDateOverride, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }
        // 1) query param
        if ( req && req.query && req.query.test_date )
        {
            const m = moment( req.query.test_date, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 2) header
        if ( req && req.headers && req.headers[ 'x-test-date' ] )
        {
            const m = moment( req.headers[ 'x-test-date' ], 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 3) cookie
        const cookieVal = getCookieValue( req, 'test_date' );
        if ( cookieVal )
        {
            const m = moment( cookieVal, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }

        // 4) session override (useful for scripted tests)
        if ( req && req.session && req.session.testDate )
        {
            const m = moment( req.session.testDate, 'YYYY-MM-DD', true );
            if ( m.isValid() ) return m.format( 'YYYY-MM-DD' );
        }
    } catch ( e ) { /* ignore and fall back to real date */ }
    return moment().format( 'YYYY-MM-DD' );
}

// --- LEAVE ACCRUAL LOGIC (ON STARTUP) ---
async function accrueLeavesForUserOnStartup ( employee )
{
    return new Promise( ( resolve, reject ) =>
    {
        const now = moment();
        const joinDate = moment( employee.join_date, 'YYYY-MM-DD' );
        let lastAccrualMonth = employee.leave_balance_last_updated ? moment( employee.leave_balance_last_updated, 'YYYY-MM' ) : joinDate.clone().startOf( 'month' );
        let currentBalance = parseFloat( employee.leave_balance ) || 0;

        let monthsToAccrue = 0;
        let tempMonth = lastAccrualMonth.clone();

        // Accrue for months since join_date or last_accrual_month up to the current month
        while ( tempMonth.isBefore( now, 'month' ) || tempMonth.isSame( now, 'month' ) )
        {
            // Ensure we don't double count the current month if already accrued
            if ( tempMonth.isSame( now, 'month' ) && employee.leave_balance_last_updated && moment( employee.leave_balance_last_updated, 'YYYY-MM' ).isSame( now, 'month' ) )
            {
                break; // Already accrued for the current month
            }
            // Accrue only if the month is after or same as join_date
            if ( tempMonth.isSameOrAfter( joinDate, 'month' ) )
            {
                monthsToAccrue++;
            }
            tempMonth.add( 1, 'month' );
        }

        if ( monthsToAccrue > 0 )
        {
            currentBalance += monthsToAccrue * 2;
            const newLastAccrualMonth = now.format( 'YYYY-MM' );
            db.run( 'UPDATE users SET leave_balance = ?, leave_balance_last_updated = ? WHERE name = ?',
                [ currentBalance, newLastAccrualMonth, employee.name ],
                ( updateErr ) =>
                {
                    if ( updateErr ) return reject( updateErr );
                    console.log( `Accrued ${ monthsToAccrue * 2 } leaves for ${ employee.name }. New balance: ${ currentBalance }` );
                    resolve( currentBalance );
                } );
        } else
        {
            resolve( currentBalance );
        }
    } );
}

// --- LEAVE BALANCE CALCULATION (READ ONLY) ---
async function calculateAndUpdateLeaveBalance ( username )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT leave_balance FROM users WHERE name = ?', [ username ], ( err, user ) =>
        {
            if ( err ) return reject( err );
            if ( !user ) return reject( new Error( 'User not found' ) );
            resolve( parseFloat( user.leave_balance ) || 0 );
        } );
    } );
}

// --- AUTHENTICATION & MIDDLEWARE ---
function requireLogin ( req, res, next )
{
    if ( !req.session || !req.session.user )
    {
        return res.redirect( '/' );
    }

    // Verify this session matches the single-session id stored on the users row.
    try
    {
        db.get( 'SELECT current_session_id FROM users WHERE name = ?', [ req.session.user.name ], ( err, row ) =>
        {
            if ( err )
            {
                console.error( 'Error verifying session id for user', req.session.user && req.session.user.name, err && err.message );
                // On DB error, allow the session (fail-open) so users are not locked out due to transient DB issues.
                return next();
            }
            const stored = ( row && row.current_session_id ) ? row.current_session_id : '';
            if ( stored && stored !== req.sessionID )
            {
                // Another session has replaced this one; destroy current session and redirect to login
                return req.session.destroy( () => res.redirect( '/?session_invalidated=1' ) );
            }
            return next();
        } );
    } catch ( e )
    {
        // If something unexpected happens, allow the request to proceed rather than blocking traffic.
        console.error( 'Unexpected error in requireLogin session check', e );
        return next();
    }
}

function requireAdmin ( req, res, next )
{
    if ( req.session.user && ( req.session.user.role === 'owner' || req.session.user.role === 'manager' ) )
    {
        next();
    } else
    {
        res.status( 403 ).send( 'You are not authorized to access that page.' );
    }
}

function requireOwner ( req, res, next )
{
    if ( req.session.user && req.session.user.role === 'owner' ) return next();
    return res.status( 403 ).send( 'Only the Owner may access this page.' );
}

// Helper: check whether a given ISO date (YYYY-MM-DD) is an off day (ad-hoc, holiday, or weekly off)
function checkIfDateIsOff ( date, callback )
{
    if ( !date ) return callback( null, { off: false } );
    const m = moment( date, 'YYYY-MM-DD', true );
    if ( !m.isValid() ) return callback( null, { off: false } );

    const mmdd = m.format( 'MM-DD' );

    // 1) Check ad-hoc offs
    db.get( 'SELECT id, reason FROM ad_hoc_offs WHERE date = ?', [ date ], ( err, adhoc ) =>
    {
        if ( err ) return callback( err );
        if ( adhoc ) return callback( null, { off: true, type: 'ad_hoc', reason: adhoc.reason, id: adhoc.id } );
        // 2) Check holidays: first check one-off full-date holidays
        db.get( 'SELECT id, name FROM holidays WHERE date = ?', [ date ], ( errDate, holDate ) =>
        {
            if ( errDate ) return callback( errDate );
            if ( holDate ) return callback( null, { off: true, type: 'holiday', name: holDate.name } );

            // 3) Check recurring holidays (month-day)
            db.get( 'SELECT id, name FROM holidays WHERE month_day = ?', [ mmdd ], ( err2, hol ) =>
            {
                if ( err2 ) return callback( err2 );
                if ( hol ) return callback( null, { off: true, type: 'holiday', name: hol.name } );

                // 4) Check weekly off mode
                db.get( 'SELECT value FROM settings WHERE name = ?', [ 'weekly_off_mode' ], ( err3, row ) =>
                {
                    if ( err3 ) return callback( err3 );
                    const mode = row && row.value ? row.value : '1';
                    const dow = m.day(); // 0=Sunday,6=Saturday

                    // Mode mapping
                    // 1 -> All Sundays off
                    // 2 -> All Sundays and Saturdays off
                    // 3 -> All Sundays and (2nd & 4th Saturdays)
                    // 4 -> All Sundays and alternate Saturdays (1st,3rd,5th)
                    if ( dow === 0 ) return callback( null, { off: true, type: 'weekly', mode } );

                    if ( dow === 6 )
                    {
                        const dom = m.date();
                        const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1; // 1-based
                        if ( mode === '2' ) return callback( null, { off: true, type: 'weekly', mode } );
                        if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) return callback( null, { off: true, type: 'weekly', mode } );
                        if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) return callback( null, { off: true, type: 'weekly', mode } );
                    }

                    return callback( null, { off: false } );
                } );
            } );
        } );
    } );
}

// --- DEVICE ACCESS HELPERS & ENFORCEMENT ---
function getCookieValue ( req, name )
{
    const header = req.headers && req.headers.cookie;
    if ( !header ) return null;
    const pairs = header.split( ';' ).map( p => p.trim() );
    for ( const p of pairs )
    {
        const parts = p.split( '=' );
        if ( parts[ 0 ] === name ) return decodeURIComponent( parts.slice( 1 ).join( '=' ) );
    }
    return null;
}

function isRequestMobile ( req )
{
    // Preferred: client sets cookie `device_type=mobile|desktop` via client-side JS
    const cookieVal = getCookieValue( req, 'device_type' );
    if ( cookieVal ) return cookieVal === 'mobile';

    // Fallback to UA sniffing (best-effort)
    const ua = ( req.headers && req.headers[ 'user-agent' ] ) || '';
    return /Mobi|Android|iPhone|iPad|Windows Phone/i.test( ua );
}

function enforceDeviceAccess ( req, res, next )
{
    // Only enforce for authenticated non-owner users. Let unauthenticated requests pass (so owner can login).
    if ( !req.session || !req.session.user || req.session.user.role === 'owner' ) return next();

    // Check current app-wide desktop flag
    db.get( 'SELECT value FROM settings WHERE name = ?', [ 'desktop_enabled' ], ( err, row ) =>
    {
        if ( err )
        {
            console.error( 'Error reading desktop_enabled setting', err && err.message );
            return next();
        }
        const enabled = row && row.value ? row.value : '1';
        if ( enabled === '1' ) return next();

        // desktop access is disabled; if request is from a desktop browser, block
        const isMobile = isRequestMobile( req );
        if ( isMobile ) return next();

        // Block desktop user (non-owner)
        // If it's an API/JSON request, return JSON; otherwise destroy session and redirect to login
        const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
        if ( acceptsJson || req.xhr )
        {
            return res.status( 403 ).json( { error: 'Desktop access has been disabled by the Owner.' } );
        }

        // Destroy session and redirect to login with a flag so the UI can show a friendly message
        req.session.destroy( () =>
        {
            return res.redirect( '/?desktop_blocked=1' );
        } );
    } );
}

// Register enforcement middleware after session/static configuration but before protected routes
app.use( enforceDeviceAccess );

// --- GENERAL & LOGIN ROUTES ---
app.get( '/', ( req, res ) =>
{
    if ( req.session.user )
    {
        // Always send logged-in users to the unified dashboard route
        res.redirect( '/dashboard' );
    } else
    {
        res.sendFile( path.join( __dirname, 'login.html' ) );
    }
} );

app.post( '/login', ( req, res ) =>
{
    const { name, password } = req.body;
    db.get( 'SELECT * FROM users WHERE name = ?', [ name ], ( err, user ) =>
    {
        if ( err )
        {
            console.error( err.message );
            req.session.loginError = 'Sorry — we had a problem signing you in. Please try again.';
            return res.redirect( '/' );
        }
        if ( user )
        {
            // If desktop access is disabled, prevent non-owner logins from desktop devices
            db.get( 'SELECT value FROM settings WHERE name = ?', [ 'desktop_enabled' ], ( setErr, setRow ) =>
            {
                if ( setErr )
                {
                    console.error( 'Error reading settings during login:', setErr && setErr.message );
                }
                const enabled = setRow && setRow.value ? setRow.value : '1';
                const isMobileReq = isRequestMobile( req );
                if ( enabled === '0' && !isMobileReq && user.role !== 'owner' )
                {
                    // Show friendly message on the login page via query param
                    req.session.loginError = null;
                    return res.redirect( '/?desktop_blocked=1' );
                }

                if ( bcrypt.compareSync( ( password || '' ).toString(), user.password ) )
                {
                    // successful login -- implement single-session mapping (Invalidate-old)
                    const prevSid = user.current_session_id || '';
                    const newSid = req.sessionID;

                    // Update DB to set the current_session_id to this session.
                    const finalizeLogin = () =>
                    {
                        req.session.user = { name: user.name, role: user.role };
                        req.session.createdAt = Date.now();
                        if ( req.session.loginError ) delete req.session.loginError;
                        return res.redirect( '/dashboard' );
                    };

                    // If there is a previous session id and it's different, attempt to destroy it.
                    if ( prevSid && prevSid !== newSid )
                    {
                        try
                        {
                            // best-effort destroy via the session store
                            if ( req.sessionStore && typeof req.sessionStore.destroy === 'function' )
                            {
                                req.sessionStore.destroy( prevSid, ( _destroyErr ) =>
                                {
                                    // ignore destroy errors and proceed to update DB
                                    db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ newSid, user.name ], ( upErr ) =>
                                    {
                                        if ( upErr ) console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                        return finalizeLogin();
                                    } );
                                } );
                            } else
                            {
                                // no store access; still update DB and proceed
                                db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ newSid, user.name ], ( upErr ) =>
                                {
                                    if ( upErr ) console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                    return finalizeLogin();
                                } );
                            }
                        } catch ( e )
                        {
                            // Unexpected error; log and finalize login
                            console.error( 'Error destroying previous session', e );
                            db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ newSid, user.name ], ( upErr ) =>
                            {
                                if ( upErr ) console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                return finalizeLogin();
                            } );
                        }
                    } else
                    {
                        // No previous session or same session - simply record the mapping and finalize
                        db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ newSid, user.name ], ( upErr ) =>
                        {
                            if ( upErr ) console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                            return finalizeLogin();
                        } );
                    }
                } else
                {
                    // invalid credentials: set session flash and redirect to login page
                    req.session.loginError = 'Incorrect username or password. Please try again.';
                    return res.redirect( '/' );
                }
            } );
        } else
        {
            // user not found
            req.session.loginError = 'Incorrect username or password. Please try again.';
            return res.redirect( '/' );
        }
    } );
} );


// Provide login error flash (read-and-clear) for client-side UI
app.get( '/login/error', ( req, res ) =>
{
    const errMsg = req.session.loginError || null;
    // clear the flash
    if ( req.session.loginError ) delete req.session.loginError;
    res.json( { error: errMsg } );
} );

app.get( '/logout', ( req, res ) =>
{
    if ( req.session && req.session.user )
    {
        const username = req.session.user.name;
        db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ '', username ], ( upErr ) =>
        {
            if ( upErr ) console.error( 'Failed to clear current_session_id on logout', upErr && upErr.message );
            req.session.destroy( () =>
            {
                res.redirect( '/' );
            } );
        } );
    } else
    {
        req.session.destroy( () =>
        {
            res.redirect( '/' );
        } );
    }
} );

app.get( '/user/me', requireLogin, ( req, res ) =>
{
    res.json( req.session.user );
} );

// Profile page (personal settings) - available to all authenticated users
app.get( '/profile', requireLogin, ( req, res ) =>
{
    return res.sendFile( path.join( __dirname, 'profile.html' ) );
} );

// --- EMPLOYEE ROUTES ---
app.get( '/dashboard', requireLogin, ( req, res ) =>
{
    // Unified dashboard route: serve admin UI to admins, employee UI to others
    const role = req.session.user && req.session.user.role;
    // Owners get the full admin UI (they don't mark attendance); managers are employees and should use the
    // regular dashboard so they can mark attendance but still access admin APIs via links.
    if ( role === 'owner' )
    {
        return res.sendFile( path.join( __dirname, 'admin.html' ) );
    }
    return res.sendFile( path.join( __dirname, 'dashboard.html' ) );
} );

// Owner-only App Settings UI
app.get( '/appsettings', requireOwner, ( req, res ) =>
{
    return res.sendFile( path.join( __dirname, 'appsettings.html' ) );
} );

// Visual calendar page (personal + manager view)
app.get( '/visual', requireLogin, ( req, res ) =>
{
    return res.sendFile( path.join( __dirname, 'visual.html' ) );
} );

// Visual calendar data (returns an HTML fragment, not JSON). Authorization rules:
// - employees may request only their own calendar
// - managers and owners may request any user's calendar
app.get( '/visual/data', requireLogin, async ( req, res ) =>
{
    try
    {
        const username = ( req.query.username || ( req.session.user && req.session.user.name ) || '' ).toString();
        const year = parseInt( req.query.year || ( new Date() ).getFullYear(), 10 );
        const month = parseInt( req.query.month || ( new Date() ).getMonth() + 1, 10 );

        if ( !username ) return res.status( 400 ).json( { error: 'username required' } );

        // basic username validation to avoid SQL injection via table name
        if ( !/^[A-Za-z0-9_]+$/.test( username ) ) return res.status( 400 ).json( { error: 'invalid username' } );

        const requester = req.session.user;
        if ( requester.role === 'employee' && requester.name !== username ) return res.status( 403 ).json( { error: 'Not authorized' } );

        const userRow = await new Promise( ( resolve ) => db.get( 'SELECT name, role FROM users WHERE name = ?', [ username ], ( err, row ) => resolve( row || null ) ) );
        if ( !userRow ) return res.status( 404 ).json( { error: 'User not found' } );
        // Defense-in-depth: do not expose visual calendar data for Owner accounts
        if ( userRow.role === 'owner' ) return res.status( 404 ).json( { error: 'User not found' } );

        const mfirst = moment( `${ year }-${ ( '' + month ).padStart( 2, '0' ) }-01`, 'YYYY-MM-DD' );
        if ( !mfirst.isValid() ) return res.status( 400 ).json( { error: 'Invalid year/month' } );
        const daysInMonth = mfirst.daysInMonth();
        const firstDate = mfirst.format( 'YYYY-MM-DD' );
        const lastDate = mfirst.clone().endOf( 'month' ).format( 'YYYY-MM-DD' );

        // Fetch required data in parallel (bulk queries)
        const attendancePromise = new Promise( ( resolve ) =>
        {
            // attendance table might not exist for owner; catch errors
            db.all( `SELECT * FROM attendance_${ username } WHERE date BETWEEN ? AND ?`, [ firstDate, lastDate ], ( err, rows ) =>
            {
                if ( err ) return resolve( [] );
                return resolve( rows || [] );
            } );
        } );

        const leavesPromise = new Promise( ( resolve ) => db.all( `SELECT leave_id, start_date, end_date, reason, status FROM leaves WHERE username = ? AND status = 'approved' AND NOT (end_date < ? OR start_date > ?)`, [ username, firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const adhocPromise = new Promise( ( resolve ) => db.all( 'SELECT date, reason FROM ad_hoc_offs WHERE date BETWEEN ? AND ?', [ firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const holidaysPromise = new Promise( ( resolve ) => db.all( 'SELECT id, name, month_day, date FROM holidays', [], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const weeklyModePromise = new Promise( ( resolve ) => db.get( "SELECT value FROM settings WHERE name = ?", [ 'weekly_off_mode' ], ( err, row ) => resolve( ( row && row.value ) ? row.value : '1' ) ) );

        const [ attendanceRows, leaveRows, adhocRows, holidaysRows, weeklyMode ] = await Promise.all( [ attendancePromise, leavesPromise, adhocPromise, holidaysPromise, weeklyModePromise ] );

        // Build lookup maps
        const attendanceMap = {};
        ( attendanceRows || [] ).forEach( r => { if ( r && r.date ) attendanceMap[ r.date ] = r; } );

        const adhocMap = {};
        ( adhocRows || [] ).forEach( a => { adhocMap[ a.date ] = a.reason || ''; } );

        const holidaysByDate = {};
        const holidaysByMMDD = {};
        ( holidaysRows || [] ).forEach( h =>
        {
            if ( h.date ) holidaysByDate[ h.date ] = h.name || '';
            if ( h.month_day ) holidaysByMMDD[ h.month_day ] = h.name || '';
        } );

        const leaves = leaveRows || [];

        const days = [];
        for ( let d = 1; d <= daysInMonth; d++ )
        {
            const date = `${ year }-${ ( '' + month ).padStart( 2, '0' ) }-${ ( '' + d ).padStart( 2, '0' ) }`;

            // check off-day: adhoc -> full-date holiday -> recurring holiday -> weekly
            let off = { off: false };
            if ( adhocMap[ date ] ) { off = { off: true, type: 'ad_hoc', reason: adhocMap[ date ] }; }
            else if ( holidaysByDate[ date ] ) { off = { off: true, type: 'holiday', name: holidaysByDate[ date ] }; }
            else
            {
                const mmdd = moment( date, 'YYYY-MM-DD' ).format( 'MM-DD' );
                if ( holidaysByMMDD[ mmdd ] ) { off = { off: true, type: 'holiday', name: holidaysByMMDD[ mmdd ] }; }
                else
                {
                    const m = moment( date, 'YYYY-MM-DD' );
                    const dow = m.day(); // 0=Sun
                    if ( dow === 0 ) off = { off: true, type: 'weekly', mode: weeklyMode };
                    else if ( dow === 6 )
                    {
                        const dom = m.date();
                        const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
                        if ( weeklyMode === '2' ) off = { off: true, type: 'weekly', mode: weeklyMode };
                        else if ( weeklyMode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) off = { off: true, type: 'weekly', mode: weeklyMode };
                        else if ( weeklyMode === '4' && ( weekOfMonth % 2 === 1 ) ) off = { off: true, type: 'weekly', mode: weeklyMode };
                    }
                }
            }

            // find approved leave covering this date
            const leave = leaves.find( L => L && L.start_date && L.end_date && ( L.start_date <= date && L.end_date >= date ) ) || null;

            // attendance row
            const att = attendanceMap[ date ] || null;

            let status = 'absent';
            let holiday_name = '';
            let adhoc_reason = '';
            if ( off && off.off )
            {
                if ( off.type === 'ad_hoc' ) { status = 'ad_hoc'; adhoc_reason = off.reason || ''; }
                else if ( off.type === 'holiday' ) { status = 'holiday'; holiday_name = off.name || ''; }
                else if ( off.type === 'weekly' ) { status = 'weekly'; }
            }

            if ( !off.off )
            {
                if ( leave ) { status = 'leave'; }
                else if ( att && att.in_time ) { status = 'present'; }
            }

            days.push( {
                date,
                status,
                in_time: att && att.in_time ? att.in_time : null,
                out_time: att && att.out_time ? att.out_time : null,
                holiday_name: holiday_name || null,
                adhoc_reason: adhoc_reason || null,
                leave: leave ? { leave_id: leave.leave_id, status: leave.status, reason: leave.reason } : null
            } );
        }

        return res.json( { year, month, days } );
    } catch ( e )
    {
        console.error( 'Error building visual data JSON:', e );
        return res.status( 500 ).json( { error: 'Server error' } );
    }
} );

// (visual page route already registered above)

app.get( '/attendance/status', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    // Owner accounts do not have attendance records — return friendly message
    if ( user && user.role === 'owner' )
    {
        return res.json( { status: 'not_applicable', message: 'Attendance is not applicable for owner/admin accounts.' } );
    }
    const today = getEffectiveDate( req );
    return checkIfDateIsOff( today, ( err, off ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        if ( off && off.off )
        {
            const msg = off.type === 'ad_hoc' ? `Today has been declared off: ${ off.reason || '' }` : ( off.type === 'holiday' ? `Today is a holiday: ${ off.name }` : 'Today is a weekly off day.' );
            return res.json( { status: 'off', message: msg } );
        }

        db.get( `SELECT * FROM attendance_${ user.name } WHERE date = ?`, [ today ], ( err2, row ) =>
        {
            if ( err2 ) return res.status( 500 ).json( { error: err2.message } );
            if ( !row ) return res.json( { status: 'not_marked_in' } );
            if ( row.in_time && !row.out_time ) return res.json( { status: 'marked_in' } );
            if ( row.in_time && row.out_time ) return res.json( { status: 'marked_out' } );
        } );
    } );
} );

app.post( '/mark-in', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = moment();
    const date = getEffectiveDate( req );
    const time = now.format( 'HH:mm:ss' );

    function doMarkIn ()
    {
        const selfiePath = path.join( selfiesDir, user.name, `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_in.jpg` );
        const base64Data = ( selfie || '' ).replace( /^data:image\/jpeg;base64,/, "" );
        fs.writeFile( selfiePath, base64Data, 'base64', ( err ) => { if ( err ) console.error( err ); } );
        // Defensive: ensure user hasn't already marked in for this date
        db.get( `SELECT in_time FROM attendance_${ user.name } WHERE date = ?`, [ date ], ( selErr, existing ) =>
        {
            if ( selErr )
            {
                console.error( selErr.message );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark in. Please try again.' } );
                return res.redirect( '/dashboard' );
            }
            if ( existing && existing.in_time )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'You have already marked in for today.' } );
                return res.redirect( '/dashboard' );
            }

            db.run( `INSERT INTO attendance_${ user.name } (date, in_time, in_latitude, in_longitude, in_selfie_path) VALUES (?, ?, ?, ?, ?)`,
                [ date, time, latitude, longitude, selfiePath ], function ( err )
            {
                if ( err )
                {
                    console.error( err.message );
                    const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                    const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                    if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark in. Please try again.' } );
                    return res.redirect( '/dashboard' );
                }
                console.log( `${ user.name } marked in on ${ now.format( 'D-MMM-YY' ) } at ${ now.format( 'h:mm A' ) }` );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.json( { success: true, message: 'Marked in successfully.' } );
                res.redirect( '/dashboard' );
            } );
        } );
    }

    // Non-owner users must not mark attendance on off-days
    if ( user && user.role !== 'owner' )
    {
        return checkIfDateIsOff( date, ( err, off ) =>
        {
            if ( err )
            {
                console.error( 'Error checking off-day', err );
                return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
            }
            if ( off && off.off )
            {
                const msg = off.type === 'ad_hoc' ? `Today has been declared off: ${ off.reason || '' }` : ( off.type === 'holiday' ? `Today is a holiday: ${ off.name }` : 'Today is a weekly off day.' );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: msg } );
                return res.redirect( '/dashboard' );
            }
            doMarkIn();
        } );
    }

    // owner or fallback
    doMarkIn();

} );

app.post( '/mark-out', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = moment();
    const date = getEffectiveDate( req );
    const time = now.format( 'HH:mm:ss' );
    function doMarkOut ()
    {
        const selfiePath = path.join( selfiesDir, user.name, `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_out.jpg` );
        const base64Data = ( selfie || '' ).replace( /^data:image\/jpeg;base64,/, "" );
        fs.writeFile( selfiePath, base64Data, 'base64', ( err ) => { if ( err ) console.error( err ); } );
        // Defensive: ensure there's an in_time and no out_time yet
        db.get( `SELECT in_time, out_time FROM attendance_${ user.name } WHERE date = ?`, [ date ], ( selErr, row ) =>
        {
            if ( selErr )
            {
                console.error( selErr.message );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark out. Please try again.' } );
                return res.redirect( '/dashboard' );
            }
            if ( !row || !row.in_time )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'Cannot mark out: no corresponding mark-in found.' } );
                return res.redirect( '/dashboard' );
            }
            if ( row.out_time )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'You have already marked out for today.' } );
                return res.redirect( '/dashboard' );
            }

            db.run( `UPDATE attendance_${ user.name } SET out_time = ?, out_latitude = ?, out_longitude = ?, out_selfie_path = ? WHERE date = ?`,
                [ time, latitude, longitude, selfiePath, date ], function ( err )
            {
                if ( err )
                {
                    console.error( err.message );
                    const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                    const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                    if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not mark out. Please try again.' } );
                    return res.redirect( '/dashboard' );
                }
                console.log( `${ user.name } marked out on ${ now.format( 'D-MMM-YY' ) } at ${ now.format( 'h:mm A' ) }` );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.json( { success: true, message: 'Marked out successfully.' } );
                res.redirect( '/dashboard' );
            } );
        } );
    }

    // Prevent marking out on owner-declared off days for non-owner users
    if ( user && user.role !== 'owner' )
    {
        return checkIfDateIsOff( date, ( err, off ) =>
        {
            if ( err )
            {
                console.error( 'Error checking off-day', err );
                return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
            }
            if ( off && off.off )
            {
                const msg = off.type === 'ad_hoc' ? `Today has been declared off: ${ off.reason || '' }` : ( off.type === 'holiday' ? `Today is a holiday: ${ off.name }` : 'Today is a weekly off day.' );
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: msg } );
                return res.redirect( '/dashboard' );
            }

            // proceed normally
            doMarkOut();
        } );
    }

    // owner or fallback
    doMarkOut();
} );

app.get( '/attendance', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    db.all( `SELECT * FROM attendance_${ user.name } ORDER BY date DESC`, [], ( err, rows ) =>
    {
        if ( err ) return console.error( err.message );
        const formattedRows = rows.map( row => ( {
            ...row,
            date: formatDateForDisplay( row.date ),
            in_time: formatTimeForDisplay( row.date, row.in_time ),
            out_time: formatTimeForDisplay( row.date, row.out_time ),
            total_time: computeTotalTimeForRow( row )
        } ) );
        res.json( formattedRows );
    } );
} );

app.get( '/leaves/balance', requireLogin, async ( req, res ) =>
{
    try
    {
        const balance = await calculateAndUpdateLeaveBalance( req.session.user.name );
        res.json( { balance } );
    } catch ( error )
    {
        res.status( 500 ).json( { error: error.message } );
    }
} );

// Provide raw attendance dates for client-side checks (YYYY-MM-DD array)
app.get( '/attendance/dates', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    db.all( `SELECT date FROM attendance_${ user.name } WHERE in_time IS NOT NULL ORDER BY date DESC`, [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const dates = ( rows || [] ).map( r => r.date );
        res.json( dates );
    } );
} );

// Provide raw leaves for client-side overlap checks (includes raw ISO dates)
app.get( '/leaves/raw', requireLogin, ( req, res ) =>
{
    const username = req.session.user.name;
    db.all( 'SELECT leave_id, start_date, end_date, status FROM leaves WHERE username = ? ORDER BY start_date DESC', [ username ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        res.json( rows || [] );
    } );
} );

app.post( '/leaves/apply', requireLogin, async ( req, res ) =>
{
    const { start_date, end_date, reason } = req.body;
    const username = req.session.user.name;

    try
    {
        // Basic date validation and ordering
        if ( !start_date || !end_date ) return res.status( 400 ).json( { success: false, message: 'Start date and end date are required.' } );
        const start = moment( start_date, 'YYYY-MM-DD', true );
        const end = moment( end_date, 'YYYY-MM-DD', true );
        if ( !start.isValid() || !end.isValid() ) return res.status( 400 ).json( { success: false, message: 'Dates must be in YYYY-MM-DD format.' } );
        if ( start.isAfter( end ) ) return res.status( 400 ).json( { success: false, message: 'Start date cannot be after end date.' } );

        const leaveDuration = end.diff( start, 'days' ) + 1;

        // Validate reason: required and max 250 characters (including spaces)
        const reasonText = ( reason || '' ).toString().trim();
        if ( !reasonText )
        {
            return res.status( 400 ).json( { success: false, message: 'Please provide a reason for the leave (max 250 characters).' } );
        }
        if ( reasonText.length > 250 )
        {
            return res.status( 400 ).json( { success: false, message: 'Reason cannot exceed 250 characters.' } );
        }
        const storedReason = reasonText.substring( 0, 250 );

        // Check attendance: user cannot apply for leave on days they have marked in
        db.all( `SELECT date FROM attendance_${ username } WHERE date BETWEEN ? AND ? AND in_time IS NOT NULL`, [ start_date, end_date ], async ( attErr, attRows ) =>
        {
            if ( attErr )
            {
                console.error( 'Error checking attendance for leave apply', attErr );
                return res.status( 500 ).json( { success: false, message: 'Could not verify attendance. Please try again.' } );
            }
            if ( attRows && attRows.length > 0 )
            {
                // Format dates for a friendlier message (e.g. 24-November-2025)
                const dates = attRows.map( r => formatDateForDisplay( r.date ) ).join( ', ' );
                return res.status( 400 ).json( { success: false, message: `You have attendance records on the following date(s): ${ dates }. You cannot apply leave for days you were present.` } );
            }

            // Check whether any requested date is an off-day (ad-hoc, holiday, weekly)
            const checkRangeForOffDates = async ( startD, endD ) =>
            {
                const found = [];
                try
                {
                    let cursor = moment( startD, 'YYYY-MM-DD' );
                    const last = moment( endD, 'YYYY-MM-DD' );
                    while ( cursor.isSameOrBefore( last, 'day' ) )
                    {
                        const dt = cursor.format( 'YYYY-MM-DD' );
                        // wrap callback-style helper
                        // eslint-disable-next-line no-await-in-loop
                        const info = await new Promise( ( resolve ) => checkIfDateIsOff( dt, ( err, res2 ) => resolve( ( err || !res2 ) ? { off: false } : res2 ) ) );
                        if ( info && info.off ) found.push( { date: dt, info } );
                        cursor.add( 1, 'day' );
                    }
                } catch ( e ) { /* ignore errors here */ }
                return found;
            };

            const offDates = await checkRangeForOffDates( start_date, end_date );
            if ( offDates && offDates.length > 0 )
            {
                const pretty = offDates.map( o =>
                {
                    const suffix = ( o.info && o.info.type === 'ad_hoc' ) ? ` (Ad-hoc: ${ ( o.info.reason || '' ) })` : ( o.info && o.info.type === 'holiday' ? ` (Holiday: ${ ( o.info.name || '' ) })` : ( o.info && o.info.type === 'weekly' ? ' (Weekly off)' : '' ) );
                    return `${ formatDateForDisplay( o.date ) }${ suffix }`;
                } ).join( ', ' );
                return res.status( 400 ).json( { success: false, message: `Cannot apply for leave on off-day(s): ${ pretty }` } );
            }

            // Check overlap with existing leaves (exclude withdrawn/taken-back requests)
            db.get( `SELECT 1 FROM leaves WHERE username = ? AND taken_back = 0 AND status IN ('pending','approved') AND NOT (end_date < ? OR start_date > ?) LIMIT 1`, [ username, start_date, end_date ], async ( ovErr, overlap ) =>
            {
                if ( ovErr )
                {
                    console.error( 'Error checking leave overlap', ovErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify existing leaves. Please try again.' } );
                }
                if ( overlap )
                {
                    return res.status( 400 ).json( { success: false, message: 'Requested dates overlap with an existing leave request.' } );
                }

                // Check balance
                try
                {
                    const balance = await calculateAndUpdateLeaveBalance( username );
                    if ( balance < leaveDuration )
                    {
                        return res.status( 400 ).json( { success: false, message: 'You do not have enough leave balance for the requested dates.' } );
                    }
                } catch ( balErr )
                {
                    console.error( 'Error checking balance', balErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave balance. Please try again.' } );
                }

                // Determine backdated flag (respect test-date override when testing)
                const today = getEffectiveDate( req );
                const isBackdated = start_date < today ? 1 : 0;

                // Insert leave with metadata
                db.run( 'INSERT INTO leaves (username, start_date, end_date, reason, is_backdated) VALUES (?, ?, ?, ?, ?)',
                    [ username, start_date, end_date, storedReason, isBackdated ], function ( insErr )
                {
                    if ( insErr )
                    {
                        console.error( 'Error inserting leave', insErr );
                        return res.status( 500 ).json( { success: false, message: 'We could not submit your leave request. Please try again later.' } );
                    }
                    console.log( `${ username } applied for leave from ${ formatDateForDisplay( start_date ) } to ${ formatDateForDisplay( end_date ) }` );
                    return res.status( 200 ).json( { success: true, message: 'Leave applied successfully.' } );
                } );
            } );
        } );
    } catch ( error )
    {
        res.status( 500 ).json( { success: false, message: error.message } );
    }
} );

// Allow users to take back (withdraw) a pending leave request
app.post( '/leaves/takeback', requireLogin, ( req, res ) =>
{
    const { leave_id } = req.body;
    const username = req.session.user.name;
    if ( !leave_id ) return res.status( 400 ).json( { success: false, message: 'leave_id is required.' } );

    db.get( 'SELECT * FROM leaves WHERE leave_id = ? AND username = ?', [ leave_id, username ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Leave request not found.' } );
        if ( row.taken_back ) return res.status( 400 ).json( { success: false, message: 'This leave request has already been taken back.' } );
        if ( row.status !== 'pending' ) return res.status( 400 ).json( { success: false, message: 'Only pending leave requests can be taken back.' } );

        const ts = new Date().toISOString();
        db.run( 'UPDATE leaves SET taken_back = 1, taken_back_at = ?, status = ? WHERE leave_id = ?', [ ts, 'withdrawn', leave_id ], function ( upErr )
        {
            if ( upErr ) return res.status( 500 ).json( { success: false, message: 'Could not take back leave request.' } );
            console.log( `${ username } withdrew leave request ${ leave_id } at ${ moment( ts ).format( 'D-MMM-YY, h:mm A' ) }` );
            return res.json( { success: true, message: 'Leave request taken back.' } );
        } );
    } );
} );

app.get( '/leaves', requireLogin, ( req, res ) =>
{
    db.all( 'SELECT * FROM leaves WHERE username = ? ORDER BY start_date DESC', [ req.session.user.name ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row =>
        {
            const fullReason = row.reason || '';
            const truncated = fullReason.length > 25 ? fullReason.substring( 0, 25 ) + '...' : fullReason;
            return {
                ...row,
                start_date: formatDateForDisplay( row.start_date ),
                end_date: formatDateForDisplay( row.end_date ),
                reason_truncated: truncated,
                reason_full: fullReason,
                is_backdated: row.is_backdated ? !!row.is_backdated : false,
                taken_back: row.taken_back ? !!row.taken_back : false,
                taken_back_at: row.taken_back_at || ''
            };
        } );
        res.json( formattedRows );
    } );
} );

// --- ADMIN ROUTES ---
app.get( '/admin', requireAdmin, ( req, res ) =>
{
    // Serve admin UI to owners and managers
    return res.sendFile( path.join( __dirname, 'admin.html' ) );
} );

app.get( '/admin/users', requireAdmin, ( req, res ) =>
{
    db.all( 'SELECT name, role FROM users', [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        res.json( rows );
    } );
} );

// --- App settings for Owner: weekly off, ad-hoc offs, holidays ---
app.get( '/admin/settings/app', requireOwner, ( req, res ) =>
{
    // return desktop_enabled, weekly_off_mode, ad_hoc_offs, holidays
    db.get( "SELECT value FROM settings WHERE name = ?", [ 'desktop_enabled' ], ( err, drow ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const desktop_enabled = drow && drow.value ? drow.value === '1' : true;
        db.get( "SELECT value FROM settings WHERE name = ?", [ 'weekly_off_mode' ], ( err2, wrow ) =>
        {
            if ( err2 ) return res.status( 500 ).json( { error: err2.message } );
            const weekly_off_mode = wrow && wrow.value ? wrow.value : '1';
            db.all( 'SELECT id, date, reason, created_by, created_at FROM ad_hoc_offs ORDER BY date ASC', [], ( err3, adhocs ) =>
            {
                if ( err3 ) return res.status( 500 ).json( { error: err3.message } );
                db.all( 'SELECT id, name, month_day, date FROM holidays ORDER BY month_day ASC, date ASC', [], ( err4, hols ) =>
                {
                    if ( err4 ) return res.status( 500 ).json( { error: err4.message } );
                    return res.json( { desktop_enabled, weekly_off_mode, ad_hoc_offs: adhocs || [], holidays: hols || [] } );
                } );
            } );
        } );
    } );
} );

// Get current permanent test-date override (owner only)
app.get( '/admin/settings/test-date', requireOwner, ( req, res ) =>
{
    const val = req.app.locals.testDateOverride || '';
    return res.json( { test_date: val || null } );
} );

// Set/clear permanent test-date override (owner only)
app.post( '/admin/settings/test-date', requireOwner, ( req, res ) =>
{
    const { test_date } = req.body || {};
    if ( test_date && !moment( test_date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'test_date must be in YYYY-MM-DD format.' } );
    const value = test_date ? test_date : '';
    db.run( 'INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)', [ 'test_date_override', value ], function ( err )
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        // update cache
        req.app.locals.testDateOverride = value;
        if ( value )
        {
            console.log( `${ req.session.user.name } set application test date override to ${ formatDateForDisplay( value ) }` );
        } else
        {
            console.log( `${ req.session.user.name } cleared the application test date override` );
        }
        return res.json( { success: true, test_date: value || null } );
    } );
} );

// Update general app settings (owner only)
app.post( '/admin/settings/app', requireOwner, ( req, res ) =>
{
    const { desktop_enabled, weekly_off_mode } = req.body || {};
    // validate weekly_off_mode
    // Supported modes: 1 (Sundays), 2 (Sundays+Saturdays), 3 (Sundays + 2nd & 4th Saturdays)
    const allowed = [ '1', '2', '3' ];
    const mode = ( '' + ( weekly_off_mode || '1' ) ).trim();
    if ( allowed.indexOf( mode ) === -1 ) return res.status( 400 ).json( { success: false, message: 'Invalid weekly off mode.' } );

    const enabled = ( desktop_enabled === true || desktop_enabled === '1' || desktop_enabled === 1 ) ? '1' : '0';
    db.run( 'INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)', [ 'desktop_enabled', enabled ] );
    db.run( 'INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)', [ 'weekly_off_mode', mode ] );
    const desktopText = ( enabled === '1' ) ? 'enabled desktop access for non-owners' : 'disabled desktop access for non-owners';
    let weeklyText = 'weekly off: Sundays';
    if ( mode === '2' ) weeklyText = 'weekly off: Sundays & Saturdays';
    else if ( mode === '3' ) weeklyText = 'weekly off: Sundays + 2nd & 4th Saturdays';
    console.log( `${ req.session.user.name } updated app settings: ${ desktopText }; ${ weeklyText }.` );
    return res.json( { success: true } );
} );

// Add ad-hoc off (owner only). date must be > today (at least one day ahead)
app.post( '/admin/settings/app/ad-hoc/add', requireOwner, ( req, res ) =>
{
    const { date, reason } = req.body || {};
    if ( !date ) return res.status( 400 ).json( { success: false, message: 'Date is required.' } );
    const m = moment( date, 'YYYY-MM-DD', true );
    if ( !m.isValid() ) return res.status( 400 ).json( { success: false, message: 'Date must be in YYYY-MM-DD format.' } );
    // must be at least one day ahead
    if ( !m.isAfter( moment(), 'day' ) ) return res.status( 400 ).json( { success: false, message: 'Ad-hoc off must be declared at least one day before.' } );
    const r = ( reason || '' ).toString().substring( 0, 250 );
    const ts = new Date().toISOString();
    db.run( 'INSERT OR REPLACE INTO ad_hoc_offs (date, reason, created_by, created_at) VALUES (?, ?, ?, ?)', [ date, r, req.session.user.name, ts ], function ( err )
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        console.log( `${ req.session.user.name } declared ad-hoc off on ${ formatDateForDisplay( date ) }${ r ? ` — reason: ${ r }` : '' }` );
        return res.json( { success: true } );
    } );
} );

// Remove ad-hoc off (owner only)
app.post( '/admin/settings/app/ad-hoc/remove', requireOwner, ( req, res ) =>
{
    const { id } = req.body || {};
    if ( !id ) return res.status( 400 ).json( { success: false, message: 'id is required.' } );
    // Fetch record to produce a friendly log, then delete
    db.get( 'SELECT date, reason FROM ad_hoc_offs WHERE id = ?', [ id ], ( getErr, row ) =>
    {
        if ( getErr ) return res.status( 500 ).json( { success: false, message: getErr.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Ad-hoc off not found.' } );
        const dateText = row.date ? formatDateForDisplay( row.date ) : `id=${ id }`;
        db.run( 'DELETE FROM ad_hoc_offs WHERE id = ?', [ id ], function ( delErr )
        {
            if ( delErr ) return res.status( 500 ).json( { success: false, message: delErr.message } );
            console.log( `${ req.session.user.name } removed ad-hoc off on ${ dateText }${ row.reason ? ` — reason: ${ row.reason }` : '' } (id=${ id })` );
            return res.json( { success: true } );
        } );
    } );
} );

// Add holiday (owner only). month_day format 'MM-DD'
app.post( '/admin/settings/app/holidays/add', requireOwner, ( req, res ) =>
{
    const { name, month_day, date } = req.body || {};
    if ( !name ) return res.status( 400 ).json( { success: false, message: 'name is required.' } );

    let insertMonthDay = null;
    let insertDate = null;

    if ( date )
    {
        // full date provided (YYYY-MM-DD)
        if ( !moment( date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'date must be YYYY-MM-DD.' } );
        insertDate = date;
        // also populate month_day for convenience
        const m = moment( date, 'YYYY-MM-DD' );
        insertMonthDay = m.format( 'MM-DD' );
    } else if ( month_day )
    {
        if ( !/^[0-1][0-9]-[0-3][0-9]$/.test( month_day ) ) return res.status( 400 ).json( { success: false, message: 'month_day must be MM-DD.' } );
        insertMonthDay = month_day;
    } else
    {
        return res.status( 400 ).json( { success: false, message: 'Provide either `date` (YYYY-MM-DD) or `month_day` (MM-DD).' } );
    }

    db.run( 'INSERT INTO holidays (name, month_day, date) VALUES (?, ?, ?)', [ name.toString().substring( 0, 100 ), insertMonthDay, insertDate ], function ( err )
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        let dateText = '';
        if ( insertDate ) dateText = formatDateForDisplay( insertDate );
        else
        {
            try
            {
                const m = moment( insertMonthDay, 'MM-DD', true );
                dateText = `recurring on ${ m.isValid() ? m.format( 'D-MMM' ) : insertMonthDay }`;
            } catch ( e ) { dateText = `recurring on ${ insertMonthDay }`; }
        }
        console.log( `${ req.session.user.name } added holiday '${ name }' — ${ dateText }` );
        return res.json( { success: true } );
    } );
} );

// Remove holiday (owner only)
app.post( '/admin/settings/app/holidays/remove', requireOwner, ( req, res ) =>
{
    const { id } = req.body || {};
    if ( !id ) return res.status( 400 ).json( { success: false, message: 'id is required.' } );
    // Fetch holiday details so we can log a friendly message, then delete
    db.get( 'SELECT name, month_day, date FROM holidays WHERE id = ?', [ id ], ( getErr, row ) =>
    {
        if ( getErr ) return res.status( 500 ).json( { success: false, message: getErr.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'Holiday not found.' } );
        let dateText = '';
        if ( row.date ) dateText = formatDateForDisplay( row.date );
        else
        {
            try
            {
                const m = moment( row.month_day, 'MM-DD', true );
                dateText = m.isValid() ? m.format( 'D-MMM' ) : row.month_day;
            } catch ( e ) { dateText = row.month_day; }
        }
        db.run( 'DELETE FROM holidays WHERE id = ?', [ id ], function ( delErr )
        {
            if ( delErr ) return res.status( 500 ).json( { success: false, message: delErr.message } );
            console.log( `${ req.session.user.name } removed holiday '${ row.name }' — ${ dateText } (id=${ id })` );
            return res.json( { success: true } );
        } );
    } );
} );

// Desktop access toggle now managed via /admin/settings/app (owner-only)

// Add new user (admins only)
app.post( '/admin/users/add', requireAdmin, ( req, res ) =>
{
    const { name, password, role } = req.body;
    const username = ( name || '' ).trim();
    const pwd = ( password && password.trim() ) ? password.trim() : '111';
    const userRole = role || 'employee';

    // Basic validation: allow only letters, numbers, underscore
    if ( !/^[A-Za-z0-9_]+$/.test( username ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Username can only contain letters, numbers, and underscore.' } );
    }

    db.get( 'SELECT name FROM users WHERE name = ?', [ username ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        if ( row ) return res.status( 400 ).json( { success: false, message: 'That username is already taken. Please choose a different one.' } );

        const joinDate = moment().format( 'YYYY-MM-DD' );
        // Prevent managers from creating owners or other managers
        if ( req.session.user && req.session.user.role === 'manager' && ( userRole === 'owner' || userRole === 'manager' ) )
        {
            return res.status( 403 ).json( { success: false, message: 'Only the Owner can create Owners or Managers.' } );
        }

        try
        {
            const pwdHash = bcrypt.hashSync( pwd, SALT_ROUNDS );
            db.run( 'INSERT INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)', [ username, pwdHash, userRole, joinDate ], function ( insertErr )
            {
                if ( insertErr ) return res.status( 500 ).json( { success: false, message: insertErr.message } );

                // Create attendance table for the user unless owner
                if ( userRole !== 'owner' )
                {
                    db.run( `CREATE TABLE IF NOT EXISTS attendance_${ username } (
                    date TEXT PRIMARY KEY,
                    in_time TEXT, in_latitude REAL, in_longitude REAL, in_selfie_path TEXT,
                    out_time TEXT, out_latitude REAL, out_longitude REAL, out_selfie_path TEXT
                )`, ( tableErr ) =>
                    {
                        if ( tableErr ) console.error( 'Error creating attendance table for', username, tableErr.message );
                    } );
                }

                // Ensure selfie directory exists
                try
                {
                    const userSelfieDir = path.join( selfiesDir, username );
                    if ( !fs.existsSync( userSelfieDir ) ) fs.mkdirSync( userSelfieDir );
                } catch ( fsErr )
                {
                    console.error( 'Error creating selfie dir for', username, fsErr.message );
                }

                console.log( `Admin ${ req.session.user.name } added user ${ username } with role ${ userRole }` );
                res.json( { success: true, message: 'User created successfully.' } );
            } );
        } catch ( e )
        {
            return res.status( 500 ).json( { success: false, message: 'Error hashing password.' } );
        }
    } );
} );

app.get( '/admin/attendance/:username', requireAdmin, ( req, res ) =>
{
    const { username } = req.params;
    db.all( `SELECT * FROM attendance_${ username } ORDER BY date DESC`, [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row => ( {
            ...row,
            date: formatDateForDisplay( row.date ),
            in_time: formatTimeForDisplay( row.date, row.in_time ),
            out_time: formatTimeForDisplay( row.date, row.out_time ),
            total_time: computeTotalTimeForRow( row )
        } ) );
        res.json( formattedRows );
    } );
} );

app.get( '/admin/leaves', requireAdmin, ( req, res ) =>
{
    const user = req.session.user;
    let query = "SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.status = 'pending' ORDER BY l.start_date ASC";

    db.all( query, [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );

        let filteredRows = rows;
        if ( user.role === 'manager' )
        {
            // Manager sees only leaves from regular employees
            filteredRows = rows.filter( row => row.role === 'employee' );
        }

        const formattedRows = filteredRows.map( row =>
        {
            const fullReason = row.reason || '';
            const truncated = fullReason.length > 25 ? fullReason.substring( 0, 25 ) + '...' : fullReason;
            return {
                ...row,
                start_date: formatDateForDisplay( row.start_date ),
                end_date: formatDateForDisplay( row.end_date ),
                reason_truncated: truncated,
                reason_full: fullReason,
                is_backdated: row.is_backdated ? !!row.is_backdated : false,
                taken_back: row.taken_back ? !!row.taken_back : false,
                taken_back_at: row.taken_back_at || ''
            };
        } );

        res.json( formattedRows );
    } );
} );

app.get( '/admin/leaves/history', requireAdmin, ( req, res ) =>
{
    db.all( "SELECT * FROM leaves ORDER BY start_date DESC", [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row =>
        {
            const fullReason = row.reason || '';
            const truncated = fullReason.length > 25 ? fullReason.substring( 0, 25 ) + '...' : fullReason;
            return {
                ...row,
                start_date: formatDateForDisplay( row.start_date ),
                end_date: formatDateForDisplay( row.end_date ),
                reason_truncated: truncated,
                reason_full: fullReason,
                is_backdated: row.is_backdated ? !!row.is_backdated : false,
                taken_back: row.taken_back ? !!row.taken_back : false,
                taken_back_at: row.taken_back_at || ''
            };
        } );
        res.json( formattedRows );
    } );
} );

app.post( '/admin/leaves/action', requireAdmin, ( req, res ) =>
{
    const { leave_id, status } = req.body;
    const admin = req.session.user;

    db.get( 'SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.leave_id = ?', [ leave_id ], ( err, leave ) =>
    {
        if ( err || !leave ) return res.status( 404 ).send( 'Leave request not found.' );

        // Prevent actions on withdrawn/taken-back requests
        if ( leave.taken_back )
        {
            return res.status( 400 ).send( 'This leave request has been withdrawn by the requester.' );
        }

        // Prevent actions on already-processed leaves (race condition protection)
        if ( leave.status !== 'pending' )
        {
            return res.status( 409 ).send( 'This leave has already been processed by another admin. Please refresh the page.' );
        }

        // Check permissions
        if ( admin.role === 'manager' && leave.role !== 'employee' )
        {
            return res.status( 403 ).send( 'You do not have permission to approve or reject this leave request.' );
        }

        if ( admin.role !== 'owner' && leave.role === 'manager' )
        {
            return res.status( 403 ).send( 'Only the Owner may approve or reject this leave request.' );
        }

        if ( status === 'approved' )
        {
            const leaveDuration = moment( leave.end_date ).diff( moment( leave.start_date ), 'days' ) + 1;
            db.run( 'UPDATE users SET leave_balance = leave_balance - ? WHERE name = ?', [ leaveDuration, leave.username ] );
        }

        db.run( 'UPDATE leaves SET status = ?, approved_by = ? WHERE leave_id = ?', [ status, admin.name, leave_id ], function ( err )
        {
            if ( err ) return res.status( 500 ).send( 'We could not process this leave request. Please try again.' );
            console.log( `${ admin.name } ${ status } leave for ${ leave.username } from dates ${ formatDateForDisplay( leave.start_date ) } to ${ formatDateForDisplay( leave.end_date ) }` );
            res.sendStatus( 200 );
        } );
    } );
} );

// --- SERVER START ---
//app.listen( port, () =>
//{
//    console.log( `Server listening at http://localhost:${ port }` );
//} );

// Admin: reset passwords for a group of users
app.post( '/admin/users/reset-password', requireAdmin, ( req, res ) =>
{
    const { username, password } = req.body;
    const newPwd = ( password && password.trim() ) ? password.trim() : '111';
    const requesterRole = req.session.user && req.session.user.role;

    if ( !username || !username.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'Please select a user to reset.' } );
    }

    const target = username.trim();
    db.get( 'SELECT role FROM users WHERE name = ?', [ target ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'The selected user was not found.' } );
        const targetRole = row.role;

        // Permission checks
        if ( requesterRole === 'owner' )
        {
            // owner can reset anyone
        } else if ( requesterRole === 'manager' )
        {
            // manager can reset only regular employees, not other managers or owners
            if ( targetRole !== 'employee' ) return res.status( 403 ).json( { success: false, message: 'You do not have permission to reset that user\'s password.' } );
        } else
        {
            return res.status( 403 ).json( { success: false, message: 'You are not authorized to perform this action.' } );
        }

        try
        {
            const newHash = bcrypt.hashSync( newPwd, SALT_ROUNDS );
            db.run( 'UPDATE users SET password = ? WHERE name = ?', [ newHash, target ], function ( updateErr )
            {
                if ( updateErr ) return res.status( 500 ).json( { success: false, message: updateErr.message } );
                return res.json( { success: true, message: `Password reset for ${ target }.` } );
            } );
        } catch ( e )
        {
            return res.status( 500 ).json( { success: false, message: 'Error hashing new password.' } );
        }
    } );
} );

// User: change own password
app.post( '/user/change-password', requireLogin, ( req, res ) =>
{
    const { old_password, new_password } = req.body;
    const username = req.session.user.name;

    if ( !new_password || !new_password.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'New password is required.' } );
    }

    db.get( 'SELECT password FROM users WHERE name = ?', [ username ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
        if ( !row ) return res.status( 404 ).json( { success: false, message: 'User not found.' } );

        // If old_password provided, verify it. If not provided, require it for safety.
        if ( !old_password )
        {
            return res.status( 400 ).json( { success: false, message: 'Current password is required for change.' } );
        }

        if ( !bcrypt.compareSync( ( old_password || '' ).toString(), row.password ) )
        {
            return res.status( 400 ).json( { success: false, message: 'Current password is incorrect.' } );
        }

        try
        {
            const newHash = bcrypt.hashSync( new_password.trim(), SALT_ROUNDS );
            db.run( 'UPDATE users SET password = ? WHERE name = ?', [ newHash, username ], function ( updateErr )
            {
                if ( updateErr ) return res.status( 500 ).json( { success: false, message: updateErr.message } );
                // Update session copy: do not store password in session
                if ( req.session.user ) req.session.user = { name: username, role: req.session.user.role };
                return res.json( { success: true, message: 'Password changed successfully.' } );
            } );
        } catch ( e )
        {
            return res.status( 500 ).json( { success: false, message: 'Error hashing new password.' } );
        }
    } );
} );

// Normalize or redirect invalid dashboard subpaths to the main dashboard
// Use app.use to match the prefix without using a path-to-regexp wildcard pattern
app.use( '/dashboard', requireLogin, ( req, res, next ) =>
{
    // If the request is to a subpath under /dashboard, redirect to base dashboard
    if ( req.method === 'GET' && req.path && req.path !== '/' && req.path !== '' )
    {
        return res.redirect( '/dashboard' );
    }
    next();
} );

// Catch-all 404 handler (serve friendly page)
app.use( ( req, res ) =>
{
    res.status( 404 ).sendFile( path.join( __dirname, '500.html' ) );
} );

// Error handler middleware (500)
app.use( ( err, req, res, next ) =>
{
    console.error( 'Server error:', err );
    if ( req.accepts( 'html' ) )
    {
        res.status( 500 ).sendFile( path.join( __dirname, '404.html' ) );
    } else
    {
        res.status( 500 ).json( { error: 'Internal Server Error' } );
    }
} );
// Export the Express app so an HTTPS server can wrap it
// Export the Express app so other wrappers can reuse it
module.exports = app;

// If this file is run directly, start an HTTPS server using local certs.
// This allows `node index.js` to start the app over HTTPS for local testing.
if ( require.main === module )
{
    const https = require( 'https' );
    const os = require( 'os' );
    const keyPath = path.join( __dirname, '192.168.1.9+1-key.pem' );
    const certPath = path.join( __dirname, '192.168.1.9+1.pem' );
    const PORT = process.env.PORT || 3000;

    if ( fs.existsSync( keyPath ) && fs.existsSync( certPath ) )
    {
        const key = fs.readFileSync( keyPath );
        const cert = fs.readFileSync( certPath );
        https.createServer( { key, cert }, app ).listen( PORT, '0.0.0.0', () =>
        {
            console.log( `HTTPS server running at https://${ os.hostname() }:${ PORT } (listening on 0.0.0.0:${ PORT })` );
            console.log( `Access by IP: https://192.168.1.9:${ PORT }` );
        } );
    } else
    {
        console.error( 'TLS certificate or key not found. Please ensure the files 192.168.1.9+1-key.pem and 192.168.1.9+1.pem exist in the project root.' );
        process.exit( 1 );
    }
}