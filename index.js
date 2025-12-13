require( 'dotenv' ).config();
const express = require( 'express' );
const path = require( 'path' );
const session = require( 'express-session' );
const fs = require( 'fs' );
const moment = require( 'moment-timezone' );
const sharp = require( 'sharp' );
const { db, users, initializeDatabase } = require( './db/database' );
const { getSetting, updateSetting, getSettings, initTimezone, updateTimezone } = require( './db/settings' );
const { getMoment } = require( './db/timezone' );
const {
    normalizeUsername,
    capitalizeUsername,
    getUserByName,
    getUserRole,
    verifyPassword,
    hashPassword,
    getCurrentSessionId,
    updateSessionId,
    getAllUsers,
    createUser,
    updatePassword,
    getLeaveBalance,
    updateLeaveBalance,
    deductLeaveBalance
} = require( './db/users' );

const app = express();
const port = process.env.PORT || 3000;

// --- DIRECTORY AND USER SETUP ---
const selfiesDir = './selfies';
if ( !fs.existsSync( selfiesDir ) )
{
    fs.mkdirSync( selfiesDir );
}

const logosDir = './logos';
if ( !fs.existsSync( logosDir ) )
{
    fs.mkdirSync( logosDir );
}

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
    secret: process.env.SESSION_SECRET || 'fallback_dev_secret_change_in_production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        secure: false, // Set to true in production with HTTPS
        sameSite: 'lax'
    },
    name: 'attendance.sid' // Custom session cookie name
} ) );
app.use( express.urlencoded( { extended: true, limit: '50mb' } ) );
app.use( express.json( { limit: '50mb' } ) );
app.use( '/selfies', express.static( 'selfies' ) );
app.use( '/logos', express.static( 'logos' ) );
// Serve public assets (CSS, JS) including mobile stylesheet
app.use( express.static( 'public' ) );

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
        const outMoment = row.out_time ? moment( `${ row.date } ${ row.out_time }`, 'YYYY-MM-DD HH:mm:ss' ) : getMoment();
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
    return getMoment().format( 'YYYY-MM-DD' );
}

// --- DATABASE INITIALIZATION ---
// Initialize database (runs migrations, seeds users, loads settings)
initializeDatabase( app, accrueLeavesForUserOnStartup );

// Initialize timezone cache
initTimezone();

// --- LEAVE ACCRUAL LOGIC (ON STARTUP) ---
async function accrueLeavesForUserOnStartup ( employee )
{
    return new Promise( ( resolve, reject ) =>
    {
        const now = getMoment();
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
            updateLeaveBalance( employee.name, currentBalance, newLastAccrualMonth )
                .then( () =>
                {
                    console.log( `Accrued ${ monthsToAccrue * 2 } leaves for ${ employee.name }. New balance: ${ currentBalance }` );
                    resolve( currentBalance );
                } )
                .catch( ( updateErr ) => reject( updateErr ) );
        } else
        {
            resolve( currentBalance );
        }
    } );
}

// --- LEAVE BALANCE CALCULATION (READ ONLY) ---
async function calculateAndUpdateLeaveBalance ( username )
{
    return getLeaveBalance( username );
}

// --- AUTHENTICATION & MIDDLEWARE ---
function requireLogin ( req, res, next )
{
    if ( !req.session || !req.session.user )
    {
        return res.redirect( '/' );
    }

    // Verify this session matches the single-session id stored on the users row.
    getCurrentSessionId( req.session.user.name )
        .then( ( stored ) =>
        {
            if ( stored && stored !== req.sessionID )
            {
                // Another session has replaced this one; destroy current session and redirect to login
                return req.session.destroy( () => res.redirect( '/?session_invalidated=1' ) );
            }
            return next();
        } )
        .catch( ( err ) =>
        {
            console.error( 'Error verifying session id for user', req.session.user && req.session.user.name, err && err.message );
            // On DB error, allow the session (fail-open) so users are not locked out due to transient DB issues.
            return next();
        } );
}

function requireAdmin ( req, res, next )
{
    if ( req.session.user && ( req.session.user.role === 'owner' || req.session.user.role === 'manager' ) )
    {
        next();
    } else
    {
        return res.redirect( '/?error=access_denied' );
    }
}

function requireOwner ( req, res, next )
{
    if ( req.session.user && req.session.user.role === 'owner' ) return next();
    return res.redirect( '/?error=access_denied' );
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
                getSetting( 'weekly_off_mode' ).then( ( value ) =>
                {
                    const mode = value || '1';
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
                } ).catch( ( err3 ) => callback( err3 ) );
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
    getSetting( 'desktop_enabled' ).then( ( value ) =>
    {
        const enabled = value || '1';
        if ( enabled === '1' ) return next();

        // desktop access is disabled; if request is from a desktop browser, block
        const isMobile = isRequestMobile( req );
        if ( isMobile ) return next();

        // Block desktop user (non-owner)
        // If it's an API/JSON request, return JSON; otherwise destroy session and redirect to login
        const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
        if ( acceptsJson || req.xhr )
        {
            return res.status( 403 ).json( { error: 'Hey there! 👋 For security, please sign in from your mobile device. Desktop access is currently disabled.' } );
        }

        // Destroy session and redirect to login with a flag so the UI can show a friendly message
        req.session.destroy( () =>
        {
            return res.redirect( '/?desktop_blocked=1' );
        } );
    } ).catch( ( err ) =>
    {
        console.error( 'Error reading desktop_enabled setting', err && err.message );
        return next();
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

app.post( '/login', async ( req, res ) =>
{
    try
    {
        const { name, password } = req.body;
        const user = await getUserByName( name );

        if ( user )
        {
            // If desktop access is disabled, prevent non-owner logins from desktop devices
            getSetting( 'desktop_enabled' ).then( ( value ) =>
            {
                const enabled = value || '1';
                const isMobileReq = isRequestMobile( req );
                if ( enabled === '0' && !isMobileReq && user.role !== 'owner' )
                {
                    // Show friendly message on the login page via query param
                    req.session.loginError = null;
                    return res.redirect( '/?desktop_blocked=1' );
                }

                if ( verifyPassword( password, user.password ) )
                {
                    // successful login -- implement single-session mapping (Invalidate-old)
                    const prevSid = user.current_session_id || '';
                    const newSid = req.sessionID;

                    // Update DB to set the current_session_id to this session.
                    const finalizeLogin = () =>
                    {
                        req.session.user = { name: user.name, role: user.role, displayName: capitalizeUsername( user.name ) };
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
                                req.sessionStore.destroy( prevSid, async ( _destroyErr ) =>
                                {
                                    // ignore destroy errors and proceed to update DB
                                    try
                                    {
                                        await updateSessionId( user.name, newSid );
                                    } catch ( upErr )
                                    {
                                        console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                    }
                                    return finalizeLogin();
                                } );
                            } else
                            {
                                // no store access; still update DB and proceed
                                ( async () =>
                                {
                                    try
                                    {
                                        await updateSessionId( user.name, newSid );
                                    } catch ( upErr )
                                    {
                                        console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                    }
                                    return finalizeLogin();
                                } )();
                            }
                        } catch ( e )
                        {
                            // Unexpected error; log and finalize login
                            console.error( 'Error destroying previous session', e );
                            ( async () =>
                            {
                                try
                                {
                                    await updateSessionId( user.name, newSid );
                                } catch ( upErr )
                                {
                                    console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                                }
                                return finalizeLogin();
                            } )();
                        }
                    } else
                    {
                        // No previous session or same session - simply record the mapping and finalize
                        ( async () =>
                        {
                            try
                            {
                                await updateSessionId( user.name, newSid );
                            } catch ( upErr )
                            {
                                console.error( 'Failed to update current_session_id after login', upErr && upErr.message );
                            }
                            return finalizeLogin();
                        } )();
                    }
                } else
                {
                    // invalid credentials: set session flash and redirect to login page
                    req.session.loginError = 'Hmm, that doesn\'t look right. Check your username and password and try again.';
                    return res.redirect( '/' );
                }
            } ).catch( ( setErr ) =>
            {
                console.error( 'Error reading settings during login:', setErr && setErr.message );
                // Continue with login on error (fail-open for settings check)
                return res.redirect( '/' );
            } );
        } else
        {
            // user not found
            req.session.loginError = 'Hmm, that doesn\'t look right. Check your username and password and try again.';
            return res.redirect( '/' );
        }
    } catch ( err )
    {
        console.error( err.message );
        req.session.loginError = 'Oops! Something went wrong. Please try signing in again.';
        return res.redirect( '/' );
    }
} );


// Provide login error flash (read-and-clear) for client-side UI
app.get( '/login/error', ( req, res ) =>
{
    const errMsg = req.session.loginError || null;
    // clear the flash
    if ( req.session.loginError ) delete req.session.loginError;
    res.json( { error: errMsg } );
} );

app.get( '/logout', async ( req, res ) =>
{
    if ( req.session && req.session.user )
    {
        const username = req.session.user.name;
        try
        {
            await updateSessionId( username, '' );
        } catch ( upErr )
        {
            console.error( 'Failed to clear current_session_id on logout', upErr && upErr.message );
        }
        req.session.destroy( () =>
        {
            res.redirect( '/' );
        } );
    } else
    {
        req.session.destroy( () =>
        {
            res.redirect( '/' );
        } );
    }
} );

app.get( '/user/me', requireLogin, async ( req, res ) =>
{
    try
    {
        const user = await getUserByName( req.session.user.name );
        if ( !user ) return res.status( 404 ).json( { error: 'User not found' } );

        // Return session data plus join_date from database
        res.json( {
            name: user.name,
            role: user.role,
            displayName: req.session.user.displayName,
            join_date: user.join_date
        } );
    } catch ( err )
    {
        res.status( 500 ).json( { error: 'Failed to fetch user data' } );
    }
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
    // Owners get redirected to /team; managers are employees and should use the
    // regular dashboard so they can mark attendance but still access team APIs via links.
    if ( role === 'owner' )
    {
        return res.redirect( '/team' );
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

        const userRow = await getUserByName( username );
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

        const leavesPromise = new Promise( ( resolve ) => db.all( `SELECT leave_id, start_date, end_date, reason, status, leave_type FROM leaves WHERE username = ? AND status = 'approved' AND NOT (end_date < ? OR start_date > ?)`, [ username, firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const adhocPromise = new Promise( ( resolve ) => db.all( 'SELECT date, reason FROM ad_hoc_offs WHERE date BETWEEN ? AND ?', [ firstDate, lastDate ], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const holidaysPromise = new Promise( ( resolve ) => db.all( 'SELECT id, name, month_day, date FROM holidays', [], ( err, rows ) => resolve( err ? [] : ( rows || [] ) ) ) );

        const weeklyModePromise = getSetting( 'weekly_off_mode' ).then( ( value ) => value || '1' ).catch( () => '1' );

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
                // Check for half-day leave with attendance
                if ( leave && leave.leave_type === 'half' && att && att.in_time )
                {
                    status = 'half_day_leave';
                }
                else if ( leave && leave.leave_type === 'full' )
                {
                    status = 'leave';
                }
                else if ( leave && leave.leave_type === 'half' && ( !att || !att.in_time ) )
                {
                    // Half-day leave but no attendance - absent for working half
                    status = 'absent_half_leave';
                }
                else if ( att && att.in_time )
                {
                    status = 'present';
                }
            }

            days.push( {
                date,
                status,
                in_time: att && att.in_time ? formatTimeForDisplay( date, att.in_time ) : null,
                out_time: att && att.out_time ? formatTimeForDisplay( date, att.out_time ) : null,
                total_time: att ? computeTotalTimeForRow( att ) : null,
                holiday_name: holiday_name || null,
                adhoc_reason: adhoc_reason || null,
                leave: leave ? { leave_id: leave.leave_id, status: leave.status, reason: leave.reason, leave_type: leave.leave_type || 'full' } : null
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

// Check if user has pending leave for today (used for pre-attendance confirmation)
app.get( '/attendance/pending-leave-check', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    const today = getEffectiveDate( req );

    // Only return pending FULL-DAY leaves (half-day leaves can coexist with attendance)
    db.get( 'SELECT leave_id, start_date, end_date, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ? AND leave_type = ?',
        [ user.name, 'pending', today, today, 'full' ], ( err, pendingLeave ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        if ( pendingLeave )
        {
            return res.json( {
                hasPendingLeave: true,
                leave_id: pendingLeave.leave_id,
                start_date: pendingLeave.start_date,
                end_date: pendingLeave.end_date,
                reason: pendingLeave.reason
            } );
        }
        return res.json( { hasPendingLeave: false } );
    } );
} );

app.get( '/attendance/status', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    // Owner accounts do not have attendance records — return friendly message
    if ( user && user.role === 'owner' )
    {
        return res.json( { status: 'not_applicable', message: 'Attendance is not applicable for owner/admin accounts.' } );
    }
    const today = getEffectiveDate( req );

    // First check if user has approved FULL-DAY leave for today (half-day leaves allow attendance)
    return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
        [ user.name, 'approved', today, today ], ( leaveErr, approvedLeave ) =>
    {
        if ( leaveErr ) return res.status( 500 ).json( { error: leaveErr.message } );
        if ( approvedLeave && approvedLeave.leave_type === 'full' )
        {
            return res.json( { status: 'off', message: 'You have approved leave today. Enjoy your time off! 🌴' } );
        }

        // Then check if it's an off-day
        return checkIfDateIsOff( today, ( err, off ) =>
        {
            if ( err ) return res.status( 500 ).json( { error: err.message } );
            if ( off && off.off )
            {
                const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                return res.json( { status: 'off', message: msg } );
            }

            // Check attendance status
            db.get( `SELECT * FROM attendance_${ user.name } WHERE date = ?`, [ today ], ( err2, row ) =>
            {
                if ( err2 ) return res.status( 500 ).json( { error: err2.message } );
                if ( !row ) return res.json( { status: 'not_marked_in' } );
                if ( row.in_time && !row.out_time ) return res.json( { status: 'marked_in' } );
                if ( row.in_time && row.out_time ) return res.json( { status: 'marked_out' } );
            } );
        } );
    } );
} );

app.post( '/mark-in', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie, confirm_withdraw } = req.body;
    const user = req.session.user;
    const now = getMoment();
    const date = getEffectiveDate( req );
    const time = now.format( 'HH:mm:ss' );

    function doMarkIn ( pendingLeaveId = null )
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
                if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Something went wrong. Please try checking in again.' } );
                return res.redirect( '/dashboard' );
            }
            if ( existing && existing.in_time )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'You\'ve already checked in today! Looking good. 😊' } );
                return res.redirect( '/dashboard' );
            }

            // If there's a pending leave to withdraw, do it first
            const finalizeMarkIn = () =>
            {
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
                    const msg = pendingLeaveId ? 'Checked in successfully! Your pending leave request has been withdrawn. ✅' : 'Checked in successfully! Have a great day! ✅';
                    if ( acceptsJson || isXhr ) return res.json( { success: true, message: msg } );
                    res.redirect( '/dashboard' );
                } );
            };

            if ( pendingLeaveId )
            {
                // Auto-withdraw the pending leave
                const ts = new Date().toISOString();
                db.run( 'UPDATE leaves SET taken_back = 1, taken_back_at = ?, status = ? WHERE leave_id = ?',
                    [ ts, 'withdrawn', pendingLeaveId ], function ( withdrawErr )
                {
                    if ( withdrawErr )
                    {
                        console.error( 'Error withdrawing pending leave:', withdrawErr );
                        const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                        const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                        if ( acceptsJson || isXhr ) return res.status( 500 ).json( { success: false, message: 'Could not withdraw pending leave. Please try again.' } );
                        return res.redirect( '/dashboard' );
                    }
                    console.log( `${ user.name } auto-withdrew pending leave ${ pendingLeaveId } upon marking attendance` );
                    finalizeMarkIn();
                } );
            } else
            {
                finalizeMarkIn();
            }
        } );
    }

    // Non-owner users must not mark attendance on off-days or when they have approved leave
    if ( user && user.role !== 'owner' )
    {
        // Check for pending leave first (only if not already confirmed by user)
        if ( !confirm_withdraw )
        {
            return db.get( 'SELECT leave_id, start_date, end_date, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
                [ user.name, 'pending', date, date ], ( pendingErr, pendingLeave ) =>
            {
                if ( pendingErr )
                {
                    console.error( 'Error checking pending leave', pendingErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
                }
                if ( pendingLeave && pendingLeave.leave_type === 'full' )
                {
                    // User has pending FULL-DAY leave - ask for confirmation
                    // Half-day leaves can coexist with attendance, so we don't prompt for them
                    const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                    if ( acceptsJson || req.xhr )
                    {
                        return res.status( 409 ).json( {
                            success: false,
                            requiresConfirmation: true,
                            leave_id: pendingLeave.leave_id,
                            message: 'You have a pending leave request for today. If you mark attendance, your leave request will be automatically withdrawn.'
                        } );
                    }
                    return res.redirect( '/dashboard' );
                }

                // No pending leave, continue with normal checks
                proceedWithApprovedLeaveCheck();
            } );
        } else
        {
            // User confirmed withdrawal, proceed with the leave_id
            const pendingLeaveId = confirm_withdraw;
            proceedWithApprovedLeaveCheck( pendingLeaveId );
        }

        function proceedWithApprovedLeaveCheck ( pendingLeaveId = null )
        {
            // Check if user has approved FULL-DAY leave for this date (half-day leaves allow attendance)
            return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
                [ user.name, 'approved', date, date ], ( leaveErr, approvedLeave ) =>
            {
                if ( leaveErr )
                {
                    console.error( 'Error checking approved leave', leaveErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
                }
                if ( approvedLeave && approvedLeave.leave_type === 'full' )
                {
                    const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                    if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: `You have approved leave today. Enjoy your time off! 🌴` } );
                    return res.redirect( '/dashboard' );
                }

                // Then check if it's an off-day
                return checkIfDateIsOff( date, ( err, off ) =>
                {
                    if ( err )
                    {
                        console.error( 'Error checking off-day', err );
                        return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
                    }
                    if ( off && off.off )
                    {
                        const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                        const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                        if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: msg } );
                        return res.redirect( '/dashboard' );
                    }
                    doMarkIn( pendingLeaveId );
                } );
            } );
        }

        return; // Exit here for non-owner users
    }

    // owner or fallback
    doMarkIn();
} );

app.post( '/mark-out', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = getMoment();
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
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'Oops! You need to check in first before checking out.' } );
                return res.redirect( '/dashboard' );
            }
            if ( row.out_time )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                const isXhr = req.xhr || ( req.headers && req.headers[ 'x-requested-with' ] === 'XMLHttpRequest' );
                if ( acceptsJson || isXhr ) return res.status( 400 ).json( { success: false, message: 'You\'ve already checked out. See you tomorrow!' } );
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
                if ( acceptsJson || isXhr ) return res.json( { success: true, message: 'All set! You\'re checked out. See you tomorrow! 👋' } );
                res.redirect( '/dashboard' );
            } );
        } );
    }

    // Prevent marking out on owner-declared off days or approved FULL-DAY leave for non-owner users
    if ( user && user.role !== 'owner' )
    {
        // First check if user has approved FULL-DAY leave for this date (half-day leaves allow attendance)
        return db.get( 'SELECT leave_id, reason, leave_type FROM leaves WHERE username = ? AND status = ? AND start_date <= ? AND end_date >= ?',
            [ user.name, 'approved', date, date ], ( leaveErr, approvedLeave ) =>
        {
            if ( leaveErr )
            {
                console.error( 'Error checking approved leave', leaveErr );
                return res.status( 500 ).json( { success: false, message: 'Could not verify leave status.' } );
            }
            if ( approvedLeave && approvedLeave.leave_type === 'full' )
            {
                const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: `You have approved leave today. Enjoy your time off! 🌴` } );
                return res.redirect( '/dashboard' );
            }

            // Then check if it's an off-day
            return checkIfDateIsOff( date, ( err, off ) =>
            {
                if ( err )
                {
                    console.error( 'Error checking off-day', err );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify off-day status.' } );
                }
                if ( off && off.off )
                {
                    const msg = off.type === 'ad_hoc' ? `Special day off today: ${ off.reason || '' } 🎉` : ( off.type === 'holiday' ? `It's a holiday today: ${ off.name } 🎊` : 'Weekly off today - enjoy your break! 😊' );
                    const acceptsJson = req.headers && req.headers.accept && req.headers.accept.indexOf( 'application/json' ) !== -1;
                    if ( acceptsJson || req.xhr ) return res.status( 403 ).json( { success: false, message: msg } );
                    return res.redirect( '/dashboard' );
                }

                // proceed normally
                doMarkOut();
            } );
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
    const { start_date, end_date, reason, leave_type } = req.body;
    const username = req.session.user.name;

    try
    {
        // Validate leave_type
        const leaveType = leave_type === 'half' ? 'half' : 'full';

        // Basic date validation and ordering
        if ( !start_date || !end_date ) return res.status( 400 ).json( { success: false, message: 'Start date and end date are required.' } );
        const start = moment( start_date, 'YYYY-MM-DD', true );
        const end = moment( end_date, 'YYYY-MM-DD', true );
        if ( !start.isValid() || !end.isValid() ) return res.status( 400 ).json( { success: false, message: 'Dates must be in YYYY-MM-DD format.' } );
        if ( start.isAfter( end ) ) return res.status( 400 ).json( { success: false, message: 'Start date cannot be after end date.' } );

        // Half-day leaves must be single-day only
        if ( leaveType === 'half' && !start.isSame( end, 'day' ) )
        {
            return res.status( 400 ).json( { success: false, message: 'Half-day leaves can only be applied for a single day.' } );
        }

        const leaveDuration = end.diff( start, 'days' ) + 1;
        const leaveDays = leaveType === 'half' ? 0.5 : leaveDuration;

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

        // Check attendance: ONLY block full-day leaves if attendance exists
        // Half-day leaves can coexist with attendance
        if ( leaveType === 'full' )
        {
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
                    return res.status( 400 ).json( { success: false, message: `You were present on: ${ dates }. You can't request time off for days you've already worked.` } );
                }
                return continueLeaveValidation();
            } );
        }
        else
        {
            // Half-day leaves can be applied even with attendance
            return continueLeaveValidation();
        }

        async function continueLeaveValidation ()
        {

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
                    return res.status( 400 ).json( { success: false, message: 'You already have a request for these dates.' } );
                }

                // Check balance
                try
                {
                    const balance = await calculateAndUpdateLeaveBalance( username );
                    if ( balance < leaveDays )
                    {
                        return res.status( 400 ).json( { success: false, message: `You don't have enough days available. Current balance: ${ balance } days.` } );
                    }
                } catch ( balErr )
                {
                    console.error( 'Error checking balance', balErr );
                    return res.status( 500 ).json( { success: false, message: 'Could not verify leave balance. Please try again.' } );
                }

                // Determine backdated flag (respect test-date override when testing)
                const today = getEffectiveDate( req );
                const isBackdated = start_date < today ? 1 : 0;

                // Insert leave with metadata including leave_type
                db.run( 'INSERT INTO leaves (username, start_date, end_date, reason, is_backdated, leave_type) VALUES (?, ?, ?, ?, ?, ?)',
                    [ username, start_date, end_date, storedReason, isBackdated, leaveType ], function ( insErr )
                {
                    if ( insErr )
                    {
                        console.error( 'Error inserting leave', insErr );
                        return res.status( 500 ).json( { success: false, message: 'We could not submit your leave request. Please try again later.' } );
                    }
                    const leaveTypeText = leaveType === 'half' ? 'half-day' : 'full-day';
                    console.log( `${ username } applied for ${ leaveTypeText } leave from ${ formatDateForDisplay( start_date ) } to ${ formatDateForDisplay( end_date ) }` );
                    return res.status( 200 ).json( { success: true, message: 'Request submitted! We\'ll let you know once it\'s reviewed. ✅' } );
                } );
            } );
        }
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
        if ( row.taken_back ) return res.status( 400 ).json( { success: false, message: 'This request was already withdrawn.' } );
        if ( row.status !== 'pending' ) return res.status( 400 ).json( { success: false, message: 'You can only withdraw pending requests.' } );

        const ts = new Date().toISOString();
        db.run( 'UPDATE leaves SET taken_back = 1, taken_back_at = ?, status = ? WHERE leave_id = ?', [ ts, 'withdrawn', leave_id ], function ( upErr )
        {
            if ( upErr ) return res.status( 500 ).json( { success: false, message: 'Could not withdraw leave request.' } );
            console.log( `${ username } withdrew leave request ${ leave_id } at ${ moment( ts ).format( 'D-MMM-YY, h:mm A' ) }` );
            return res.json( { success: true, message: 'Request withdrawn successfully.' } );
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

// --- TEAM MANAGEMENT ROUTES ---
app.get( '/team', requireAdmin, ( req, res ) =>
{
    // Serve team management UI to owners and managers
    return res.sendFile( path.join( __dirname, 'team.html' ) );
} );

app.get( '/admin/users', requireAdmin, async ( req, res ) =>
{
    try
    {
        const users = await getAllUsers();
        res.json( users );
    } catch ( err )
    {
        res.status( 500 ).json( { error: err.message } );
    }
} );

// --- App settings for Owner: weekly off, ad-hoc offs, holidays ---
app.get( '/admin/settings/app', requireOwner, async ( req, res ) =>
{
    try
    {
        // Get settings using module
        const settings = await getSettings( [ 'desktop_enabled', 'weekly_off_mode', 'timezone' ] );
        const desktop_enabled = settings.desktop_enabled === '1';
        const weekly_off_mode = settings.weekly_off_mode || '1';
        const timezone = settings.timezone || 'Asia/Kolkata';

        // Get ad-hoc offs and holidays
        const adhocPromise = new Promise( ( resolve, reject ) => db.all( 'SELECT id, date, reason, created_by, created_at FROM ad_hoc_offs ORDER BY date ASC', [], ( err, rows ) => err ? reject( err ) : resolve( rows || [] ) ) );
        const holidaysPromise = new Promise( ( resolve, reject ) => db.all( 'SELECT id, name, month_day, date FROM holidays ORDER BY month_day ASC, date ASC', [], ( err, rows ) => err ? reject( err ) : resolve( rows || [] ) ) );

        const [ adhocs, hols ] = await Promise.all( [ adhocPromise, holidaysPromise ] );

        return res.json( { desktop_enabled, weekly_off_mode, timezone, ad_hoc_offs: adhocs, holidays: hols } );
    } catch ( error )
    {
        return res.status( 500 ).json( { error: error.message } );
    }
} );

// Get current permanent test-date override (owner only)
app.get( '/admin/settings/test-date', requireOwner, ( req, res ) =>
{
    const val = req.app.locals.testDateOverride || '';
    return res.json( { test_date: val || null } );
} );

// Set/clear permanent test-date override (owner only)
app.post( '/admin/settings/test-date', requireOwner, async ( req, res ) =>
{
    try
    {
        const { test_date } = req.body || {};
        if ( test_date && !moment( test_date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'Please use YYYY-MM-DD format (like 2025-12-25).' } );
        const value = test_date ? test_date : '';

        await updateSetting( 'test_date_override', value );

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
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message } );
    }
} );

// Update general app settings (owner only)
app.post( '/admin/settings/app', requireOwner, async ( req, res ) =>
{
    try
    {
        const { desktop_enabled, weekly_off_mode } = req.body || {};
        // validate weekly_off_mode
        // Supported modes: 1 (Sundays), 2 (Sundays+Saturdays), 3 (Sundays + 2nd & 4th Saturdays)
        const allowed = [ '1', '2', '3' ];
        const mode = ( '' + ( weekly_off_mode || '1' ) ).trim();
        if ( allowed.indexOf( mode ) === -1 ) return res.status( 400 ).json( { success: false, message: 'Please choose a valid weekly off mode (1, 2, or 3).' } );

        const enabled = ( desktop_enabled === true || desktop_enabled === '1' || desktop_enabled === 1 ) ? '1' : '0';

        await updateSetting( 'desktop_enabled', enabled );
        await updateSetting( 'weekly_off_mode', mode );

        const desktopText = ( enabled === '1' ) ? 'Desktop access is now on for team members' : 'Desktop access is now off - mobile only';
        let weeklyText = 'Weekly offs: Sundays';
        if ( mode === '2' ) weeklyText = 'Weekly offs: Sundays & Saturdays';
        else if ( mode === '3' ) weeklyText = 'Weekly offs: Sundays + 2nd & 4th Saturdays';
        console.log( `${ req.session.user.name } updated app settings: ${ desktopText }; ${ weeklyText }.` );
        return res.json( { success: true, message: 'Settings saved! All updated. ✅' } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message } );
    }
} );

// Update timezone setting (owner only)
app.post( '/admin/settings/timezone', requireOwner, async ( req, res ) =>
{
    try
    {
        const { timezone } = req.body || {};
        if ( !timezone ) return res.status( 400 ).json( { success: false, message: 'Timezone is required.' } );

        await updateTimezone( timezone );
        console.log( `${ req.session.user.name } updated timezone to: ${ timezone }` );
        return res.json( { success: true, message: 'Timezone updated successfully!' } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: err.message || 'Invalid timezone' } );
    }
} );

// Add ad-hoc off (owner only). date must be > today (at least one day ahead)
app.post( '/admin/settings/app/ad-hoc/add', requireOwner, ( req, res ) =>
{
    const { date, reason } = req.body || {};
    if ( !date ) return res.status( 400 ).json( { success: false, message: 'Date is required.' } );
    const m = moment( date, 'YYYY-MM-DD', true );
    if ( !m.isValid() ) return res.status( 400 ).json( { success: false, message: 'Date must be in YYYY-MM-DD format.' } );
    // must be at least one day ahead
    if ( !m.isAfter( getMoment(), 'day' ) ) return res.status( 400 ).json( { success: false, message: 'Ad-hoc off must be declared at least one day before.' } );

    // Check if date is already a weekly off
    getSetting( 'weekly_off_mode' ).then( ( value ) =>
    {
        const mode = value || '1';
        const dow = m.day(); // 0=Sunday, 6=Saturday

        let isWeeklyOff = false;
        if ( dow === 0 ) isWeeklyOff = true; // All Sundays
        else if ( dow === 6 )
        {
            const dom = m.date();
            const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
            if ( mode === '2' ) isWeeklyOff = true; // All Saturdays
            else if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) isWeeklyOff = true; // 2nd & 4th Saturdays
            else if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) isWeeklyOff = true; // 1st, 3rd, 5th Saturdays
        }

        if ( isWeeklyOff )
        {
            return res.status( 400 ).json( { success: false, message: 'This date is already a weekly off. No need to add it as a special day off.' } );
        }

        const r = ( reason || '' ).toString().substring( 0, 250 );
        const ts = new Date().toISOString();
        db.run( 'INSERT OR REPLACE INTO ad_hoc_offs (date, reason, created_by, created_at) VALUES (?, ?, ?, ?)', [ date, r, req.session.user.name, ts ], function ( err )
        {
            if ( err ) return res.status( 500 ).json( { success: false, message: err.message } );
            console.log( `${ req.session.user.name } declared ad-hoc off on ${ formatDateForDisplay( date ) }${ r ? ` — reason: ${ r }` : '' }` );
            return res.json( { success: true } );
        } );
    } ).catch( ( err ) => res.status( 500 ).json( { success: false, message: err.message } ) );
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
    let checkDate = null;

    if ( date )
    {
        // full date provided (YYYY-MM-DD)
        if ( !moment( date, 'YYYY-MM-DD', true ).isValid() ) return res.status( 400 ).json( { success: false, message: 'date must be YYYY-MM-DD.' } );
        insertDate = date;
        checkDate = moment( date, 'YYYY-MM-DD' );
        // also populate month_day for convenience
        insertMonthDay = checkDate.format( 'MM-DD' );
    } else if ( month_day )
    {
        if ( !/^[0-1][0-9]-[0-3][0-9]$/.test( month_day ) ) return res.status( 400 ).json( { success: false, message: 'month_day must be MM-DD.' } );
        insertMonthDay = month_day;
        // For recurring, check current year's occurrence
        checkDate = moment( `${ getMoment().year() }-${ month_day }`, 'YYYY-MM-DD' );
    } else
    {
        return res.status( 400 ).json( { success: false, message: 'Provide either `date` (YYYY-MM-DD) or `month_day` (MM-DD).' } );
    }

    // Check if the date falls on a weekly off
    getSetting( 'weekly_off_mode' ).then( ( value ) =>
    {
        const mode = value || '1';
        const dow = checkDate.day(); // 0=Sunday, 6=Saturday

        let isWeeklyOff = false;
        if ( dow === 0 ) isWeeklyOff = true; // All Sundays
        else if ( dow === 6 )
        {
            const dom = checkDate.date();
            const weekOfMonth = Math.floor( ( dom - 1 ) / 7 ) + 1;
            if ( mode === '2' ) isWeeklyOff = true; // All Saturdays
            else if ( mode === '3' && ( weekOfMonth === 2 || weekOfMonth === 4 ) ) isWeeklyOff = true; // 2nd & 4th Saturdays
            else if ( mode === '4' && ( weekOfMonth % 2 === 1 ) ) isWeeklyOff = true; // 1st, 3rd, 5th Saturdays
        }

        if ( isWeeklyOff )
        {
            return res.status( 400 ).json( { success: false, message: 'This date falls on a weekly off. No need to add it as a holiday.' } );
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
    } ).catch( ( err ) => res.status( 500 ).json( { success: false, message: err.message } ) );
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

// --- BRANDING ENDPOINTS ---

// Get branding settings (public endpoint - no auth required)
app.get( '/branding', async ( req, res ) =>
{
    try
    {
        const settings = await getSettings( [ 'company_logo', 'brand_color', 'company_name', 'timezone' ] );

        res.json( {
            logo: settings.company_logo || '',
            brandColor: settings.brand_color || '#0ea5a4',
            companyName: settings.company_name || 'Attendance System',
            timezone: settings.timezone || 'Asia/Kolkata'
        } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false } );
    }
} );

// Upload company logo (owner only)
app.post( '/admin/settings/logo', requireOwner, async ( req, res ) =>
{
    const { logo } = req.body;

    if ( !logo || !logo.startsWith( 'data:image' ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please provide a valid image.' } );
    }

    try
    {
        // Extract base64 data
        const matches = logo.match( /^data:image\/(\w+);base64,(.+)$/ );
        if ( !matches )
        {
            return res.status( 400 ).json( { success: false, message: 'Invalid image format.' } );
        }

        const base64Data = matches[ 2 ];
        const buffer = Buffer.from( base64Data, 'base64' );

        // Check original file size (limit to 5MB before compression)
        const originalSizeKB = buffer.length / 1024;
        if ( originalSizeKB > 5120 )
        {
            return res.status( 400 ).json( {
                success: false,
                message: `Image is too large (${ Math.round( originalSizeKB / 1024 ) }MB). Please upload an image smaller than 5MB.`
            } );
        }

        // Compress and resize image using sharp
        // Max width: 400px, Max quality: 80%, Convert to WebP for better compression
        const compressedBuffer = await sharp( buffer )
            .resize( { width: 400, fit: 'inside', withoutEnlargement: true } )
            .webp( { quality: 80 } )
            .toBuffer();

        const compressedSizeKB = compressedBuffer.length / 1024;
        console.log( `Logo compressed: ${ Math.round( originalSizeKB ) }KB → ${ Math.round( compressedSizeKB ) }KB (${ Math.round( ( 1 - compressedSizeKB / originalSizeKB ) * 100 ) }% reduction)` );

        // Save compressed image
        const filename = 'company-logo.webp';
        const filepath = path.join( logosDir, filename );

        fs.writeFileSync( filepath, compressedBuffer );

        const logoPath = `/logos/${ filename }`;

        // Update database
        await updateSetting( 'company_logo', logoPath );

        console.log( `${ req.session.user.name } uploaded company logo: ${ logoPath } (${ Math.round( compressedSizeKB ) }KB)` );
        res.json( {
            success: true,
            message: `Logo uploaded successfully! (Compressed to ${ Math.round( compressedSizeKB ) }KB)`,
            logoPath
        } );
    }
    catch ( error )
    {
        console.error( 'Logo upload error:', error );
        res.status( 500 ).json( { success: false, message: 'Failed to process logo upload. Please try a different image.' } );
    }
} );

// Remove company logo (owner only)
app.post( '/admin/settings/logo/remove', requireOwner, async ( req, res ) =>
{
    try
    {
        const logoValue = await getSetting( 'company_logo' );

        if ( !logoValue )
        {
            return res.json( { success: true, message: 'No logo to remove.' } );
        }

        // Delete file if exists
        const logoPath = logoValue.replace( '/logos/', '' );
        const filepath = path.join( logosDir, logoPath );

        if ( fs.existsSync( filepath ) )
        {
            fs.unlinkSync( filepath );
        }

        // Clear database
        await updateSetting( 'company_logo', '' );

        console.log( `${ req.session.user.name } removed company logo` );
        res.json( { success: true, message: 'Logo removed successfully!' } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to remove logo.' } );
    }
} );

// Update brand color (owner only)
app.post( '/admin/settings/brand-color', requireOwner, async ( req, res ) =>
{
    const { color } = req.body;

    // Validate hex color format
    if ( !color || !/^#[0-9A-Fa-f]{6}$/.test( color ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please provide a valid hex color (e.g., #0ea5a4).' } );
    }

    try
    {
        await updateSetting( 'brand_color', color );

        console.log( `${ req.session.user.name } updated brand color to ${ color }` );
        res.json( { success: true, message: 'Brand color updated successfully!' } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to update brand color.' } );
    }
} );

// Update company name (owner only)
app.post( '/admin/settings/company-name', requireOwner, async ( req, res ) =>
{
    try
    {
        const { name } = req.body;
        const companyName = ( name || '' ).trim();

        if ( !companyName )
        {
            return res.status( 400 ).json( { success: false, message: 'Please provide a company name.' } );
        }

        await updateSetting( 'company_name', companyName );

        console.log( `${ req.session.user.name } updated company name to "${ companyName }"` );
        res.json( { success: true, message: 'Company name updated successfully!' } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to update company name.' } );
    }
} );

// Reset brand color to default (owner only)
app.post( '/admin/settings/brand-color/reset', requireOwner, async ( req, res ) =>
{
    try
    {
        const defaultColor = '#0ea5a4';

        await updateSetting( 'brand_color', defaultColor );

        console.log( `${ req.session.user.name } reset brand color to default` );
        res.json( { success: true, message: 'Brand color reset to default!', color: defaultColor } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to reset brand color.' } );
    }
} );

// Reset company name to default (owner only)
app.post( '/admin/settings/company-name/reset', requireOwner, async ( req, res ) =>
{
    try
    {
        const defaultName = 'Attendance System';

        await updateSetting( 'company_name', defaultName );

        console.log( `${ req.session.user.name } reset company name to default` );
        res.json( { success: true, message: 'Company name reset to default!', name: defaultName } );
    } catch ( err )
    {
        return res.status( 500 ).json( { success: false, message: 'Failed to reset company name.' } );
    }
} );

// Database backup download (owner-only)
app.get( '/admin/backup/download', requireOwner, ( req, res ) =>
{
    try
    {
        const dbPath = path.join( __dirname, 'attendance.db' );

        // Check if database file exists
        if ( !fs.existsSync( dbPath ) )
        {
            return res.status( 404 ).json( { success: false, message: 'Database file not found.' } );
        }

        console.log( `${ req.session.user.name } downloaded database backup` );

        // Send file for download
        res.download( dbPath, 'attendance-backup.db', ( err ) =>
        {
            if ( err )
            {
                console.error( 'Error downloading backup:', err );
                if ( !res.headersSent )
                {
                    res.status( 500 ).json( { success: false, message: 'Failed to download backup.' } );
                }
            }
        } );
    } catch ( err )
    {
        console.error( 'Backup download error:', err );
        return res.status( 500 ).json( { success: false, message: 'Failed to download backup.' } );
    }
} );

// Desktop access toggle now managed via /admin/settings/app (owner-only)

// Add new user (admins only)
app.post( '/admin/users/add', requireAdmin, async ( req, res ) =>
{
    const { name, password, role, join_date } = req.body;
    const rawUsername = ( name || '' ).trim();
    const pwd = ( password && password.trim() ) ? password.trim() : '111';
    const userRole = role || 'employee';

    // Basic validation: allow only letters (spaces, dots, hyphens will be normalized)
    if ( !/^[A-Za-z.\-_\s]+$/.test( rawUsername ) )
    {
        return res.status( 400 ).json( { success: false, message: 'Please use only letters (spaces, dots, and hyphens are allowed).' } );
    }

    try
    {
        const username = normalizeUsername( rawUsername );
        const displayName = capitalizeUsername( rawUsername );

        const existingUser = await getUserByName( username );
        if ( existingUser ) return res.status( 400 ).json( { success: false, message: 'This username is taken. Please try a different one.' } );

        // Use provided join_date or default to today
        const joinDate = ( join_date && join_date.trim() ) ? join_date.trim() : getMoment().format( 'YYYY-MM-DD' );
        // Prevent managers from creating owners or other managers
        if ( req.session.user && req.session.user.role === 'manager' && ( userRole === 'owner' || userRole === 'manager' ) )
        {
            return res.status( 403 ).json( { success: false, message: 'Only the system owner can add managers or other owners.' } );
        }

        // Create user with hashed password
        await createUser( username, pwd, userRole, joinDate );

        // Create attendance table for the user unless owner
        if ( userRole !== 'owner' )
        {
            await new Promise( ( resolve, reject ) =>
            {
                db.run( `CREATE TABLE IF NOT EXISTS attendance_${ username } (
                    date TEXT PRIMARY KEY,
                    in_time TEXT, in_latitude REAL, in_longitude REAL, in_selfie_path TEXT,
                    out_time TEXT, out_latitude REAL, out_longitude REAL, out_selfie_path TEXT
                )`, ( tableErr ) =>
                {
                    if ( tableErr )
                    {
                        console.error( 'Error creating attendance table for', username, tableErr.message );
                        return reject( tableErr );
                    }
                    resolve();
                } );
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
        res.json( { success: true, message: 'Team member added! They can now sign in. 🎉' } );
    } catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error creating user.' } );
    }
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

app.post( '/admin/leaves/action', requireAdmin, async ( req, res ) =>
{
    const { leave_id, status } = req.body;
    const admin = req.session.user;

    try
    {
        const leave = await new Promise( ( resolve, reject ) =>
        {
            db.get( 'SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.leave_id = ?', [ leave_id ], ( err, row ) =>
            {
                if ( err ) return reject( err );
                resolve( row );
            } );
        } );

        if ( !leave ) return res.status( 404 ).send( 'Leave request not found.' );

        // Prevent actions on withdrawn/taken-back requests
        if ( leave.taken_back )
        {
            return res.status( 400 ).send( 'This request was withdrawn by the team member.' );
        }

        // Prevent actions on already-processed leaves (race condition protection)
        if ( leave.status !== 'pending' )
        {
            return res.status( 409 ).send( 'This request was already processed. Please refresh the page to see the latest status.' );
        }

        // Check permissions
        if ( admin.role === 'manager' && leave.role !== 'employee' )
        {
            return res.status( 403 ).send( 'You can only approve or decline requests from team members (not managers or owners).' );
        }

        if ( admin.role !== 'owner' && leave.role === 'manager' )
        {
            return res.status( 403 ).send( 'Only the system owner can approve or decline manager requests.' );
        }

        if ( status === 'approved' )
        {
            // Calculate leave days based on leave_type
            const leaveDuration = moment( leave.end_date ).diff( moment( leave.start_date ), 'days' ) + 1;
            const leaveDays = leave.leave_type === 'half' ? 0.5 : leaveDuration;
            await deductLeaveBalance( leave.username, leaveDays );
        }

        await new Promise( ( resolve, reject ) =>
        {
            db.run( 'UPDATE leaves SET status = ?, approved_by = ? WHERE leave_id = ?', [ status, admin.name, leave_id ], function ( err )
            {
                if ( err ) return reject( err );
                resolve();
            } );
        } );

        console.log( `${ admin.name } ${ status } leave for ${ leave.username } from dates ${ formatDateForDisplay( leave.start_date ) } to ${ formatDateForDisplay( leave.end_date ) }` );
        res.sendStatus( 200 );
    } catch ( err )
    {
        return res.status( 500 ).send( 'Something went wrong. Please try processing this request again.' );
    }
} );

// --- SERVER START ---
//app.listen( port, () =>
//{
//    console.log( `Server listening at http://localhost:${ port }` );
//} );

// Admin: reset passwords for a group of users
app.post( '/admin/users/reset-password', requireAdmin, async ( req, res ) =>
{
    const { username, password } = req.body;
    const newPwd = ( password && password.trim() ) ? password.trim() : '111';
    const requesterRole = req.session.user && req.session.user.role;

    if ( !username || !username.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'Please select a team member to reset.' } );
    }

    try
    {
        const target = username.trim();
        const targetRole = await getUserRole( target );
        if ( !targetRole ) return res.status( 404 ).json( { success: false, message: 'We couldn\'t find that team member.' } );

        // Permission checks
        if ( requesterRole === 'owner' )
        {
            // owner can reset anyone
        } else if ( requesterRole === 'manager' )
        {
            // manager can reset only regular employees, not other managers or owners
            if ( targetRole !== 'employee' ) return res.status( 403 ).json( { success: false, message: 'You can only reset passwords for team members (not managers or owners).' } );
        } else
        {
            return res.status( 403 ).json( { success: false, message: 'You\'re not authorized to do this.' } );
        }

        await updatePassword( target, newPwd );
        return res.json( { success: true, message: `Password reset for ${ target }. Their new password is: ${ newPwd }` } );
    } catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error resetting password.' } );
    }
} );

// User: change own password
app.post( '/user/change-password', requireLogin, async ( req, res ) =>
{
    const { old_password, new_password } = req.body;
    const username = req.session.user.name;

    if ( !new_password || !new_password.trim() )
    {
        return res.status( 400 ).json( { success: false, message: 'Please enter a new password.' } );
    }

    try
    {
        const user = await getUserByName( username );
        if ( !user ) return res.status( 404 ).json( { success: false, message: 'User not found.' } );

        // If old_password provided, verify it. If not provided, require it for safety.
        if ( !old_password )
        {
            return res.status( 400 ).json( { success: false, message: 'Please enter your current password to confirm.' } );
        }

        if ( !verifyPassword( ( old_password || '' ).toString(), user.password ) )
        {
            return res.status( 400 ).json( { success: false, message: 'Hmm, that current password doesn\'t match. Please try again.' } );
        }

        await updatePassword( username, new_password.trim() );
        // Update session copy: do not store password in session
        if ( req.session.user ) req.session.user = { name: username, role: req.session.user.role };
        return res.json( { success: true, message: 'Password updated! All set. ✅' } );
    } catch ( e )
    {
        return res.status( 500 ).json( { success: false, message: e.message || 'Error updating password.' } );
    }
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
    res.status( 404 ).sendFile( path.join( __dirname, '404.html' ) );
} );

// Error handler middleware (500)
app.use( ( err, req, res, next ) =>
{
    console.error( 'Server error:', err );
    if ( req.accepts( 'html' ) )
    {
        res.status( 500 ).sendFile( path.join( __dirname, '500.html' ) );
    } else
    {
        res.status( 500 ).json( { error: 'Internal Server Error' } );
    }
} );
// Export the Express app so an HTTPS server can wrap it
// Export the Express app so other wrappers can reuse it
module.exports = app;

// If this file is run directly, start a server
if ( require.main === module )
{
    const PORT = process.env.PORT || 3000;
    const os = require( 'os' );

    // Find certificate files dynamically (any .pem files in project root)
    const pemFiles = fs.readdirSync( __dirname ).filter( f => f.endsWith( '.pem' ) );
    const keyFile = pemFiles.find( f => f.includes( '-key' ) );
    const certFile = pemFiles.find( f => !f.includes( '-key' ) && f.endsWith( '.pem' ) );

    // Check if we're in production or if no certs are available
    const isProduction = process.env.NODE_ENV === 'production';
    const hasCerts = keyFile && certFile;

    if ( !isProduction && hasCerts )
    {
        // Local development with HTTPS (for mobile testing with camera/geolocation)
        const https = require( 'https' );
        const keyPath = path.join( __dirname, keyFile );
        const certPath = path.join( __dirname, certFile );

        try
        {
            const key = fs.readFileSync( keyPath );
            const cert = fs.readFileSync( certPath );
            https.createServer( { key, cert }, app ).listen( PORT, '0.0.0.0', () =>
            {
                // Get local IP address
                const networkInterfaces = os.networkInterfaces();
                const localIP = Object.values( networkInterfaces )
                    .flat()
                    .find( iface => iface.family === 'IPv4' && !iface.internal )?.address || 'localhost';

                console.log( `✅ HTTPS server running on port ${ PORT }` );
                console.log( `📱 Access from mobile: https://${ localIP }:${ PORT }` );
                console.log( `💻 Access locally: https://localhost:${ PORT }` );
                console.log( `🔒 Using certificates: ${ keyFile }, ${ certFile }` );
            } );
        } catch ( err )
        {
            console.error( '❌ Failed to start HTTPS server:', err.message );
            console.log( '⚠️  Falling back to HTTP...' );
            startHttpServer();
        }
    }
    else
    {
        // Production or no certs: Use plain HTTP (hosting platforms handle HTTPS)
        if ( isProduction )
        {
            console.log( '🌐 Production mode: Starting HTTP server (platform handles HTTPS)' );
        }
        else
        {
            console.log( '⚠️  No certificates found. Starting HTTP server.' );
            console.log( '💡 To use HTTPS locally (required for mobile camera/GPS):' );
            console.log( '   1. Install mkcert: https://github.com/FiloSottile/mkcert' );
            console.log( '   2. Run: mkcert -install' );
            console.log( '   3. Run: mkcert localhost 127.0.0.1 <your-local-ip>' );
            console.log( '   4. Place the generated .pem files in the project root' );
        }
        startHttpServer();
    }

    function startHttpServer ()
    {
        app.listen( PORT, '0.0.0.0', () =>
        {
            const networkInterfaces = os.networkInterfaces();
            const localIP = Object.values( networkInterfaces )
                .flat()
                .find( iface => iface.family === 'IPv4' && !iface.internal )?.address || 'localhost';

            console.log( `✅ HTTP server running on port ${ PORT }` );
            console.log( `📱 Access from mobile: http://${ localIP }:${ PORT }` );
            console.log( `💻 Access locally: http://localhost:${ PORT }` );
        } );
    }
}