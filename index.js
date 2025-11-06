const express = require( 'express' );
const sqlite3 = require( 'sqlite3' ).verbose();
const path = require( 'path' );
const session = require( 'express-session' );
const fs = require( 'fs' );
const moment = require( 'moment' );

const app = express();
const port = 3000;

// --- DIRECTORY AND USER SETUP ---
const selfiesDir = './selfies';
if ( !fs.existsSync( selfiesDir ) )
{
    fs.mkdirSync( selfiesDir );
}

const users = [
    { name: 'smita', password: 'theory', role: 'owner_admin' },
    { name: 'dinesh', password: 'theory', role: 'employee_admin' },
    { name: 'abdul', password: 'dharma', role: 'employee' },
    { name: 'suresh', password: 'iloveyou', role: 'employee' },
    { name: 'mahesh', password: 'password123', role: 'employee' }
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
    // Users table with roles, leave balance, and last update timestamp
    db.run( 'CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password TEXT, role TEXT, leave_balance REAL DEFAULT 0, leave_balance_last_updated TEXT)', ( err ) =>
    {
        if ( err )
        {
            console.error( "Error creating users table", err.message );
            return;
        }
        // Add new columns if they don't exist. This is for existing databases.
        db.run( "ALTER TABLE users ADD COLUMN leave_balance REAL DEFAULT 0", () => { } );
        db.run( "ALTER TABLE users ADD COLUMN leave_balance_last_updated TEXT", () => { } );
    } );

    const stmtUsers = db.prepare( 'INSERT OR IGNORE INTO users (name, password, role) VALUES (?, ?, ?)' );
    users.forEach( user =>
    {
        stmtUsers.run( user.name, user.password, user.role );
    } );
    stmtUsers.finalize();

    // Attendance tables
    users.forEach( user =>
    {
        if ( user.role !== 'owner_admin' )
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
} );

// --- HELPER FUNCTIONS ---
function formatDateTimeForDisplay ( date, time )
{
    if ( !date || !time ) return null;
    return moment( `${ date } ${ time }`, 'YYYY-MM-DD HH:mm:ss' ).format( 'DD-MMMM-YYYY, h:mm A' );
}

function formatTimeForDisplay ( date, time )
{
    if ( !date || !time ) return null;
    return moment( `${ date } ${ time }`, 'YYYY-MM-DD HH:mm:ss' ).format( 'h:mm A' );
}

function formatDateForDisplay ( date )
{
    if ( !date ) return null;
    return moment( date, 'YYYY-MM-DD' ).format( 'DD-MMMM-YYYY' );
}

// --- LEAVE BALANCE CALCULATION ---
async function calculateAndUpdateLeaveBalance(username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT leave_balance, leave_balance_last_updated FROM users WHERE name = ?', [username], (err, user) => {
            if (err) return reject(err);
            if (!user) return reject(new Error('User not found'));

            const now = moment();
            let lastUpdated = user.leave_balance_last_updated ? moment(user.leave_balance_last_updated, 'YYYY-MM') : null;
            let balance = user.leave_balance;

            // If lastUpdated is null, it's the first time. Initialize balance.
            if (lastUpdated === null) {
                balance = 2; // Initial balance
                lastUpdated = now;
                db.run('UPDATE users SET leave_balance = ?, leave_balance_last_updated = ? WHERE name = ?',
                    [balance, lastUpdated.format('YYYY-MM'), username],
                    (updateErr) => {
                        if (updateErr) return reject(updateErr);
                        resolve(balance);
                    });
            } else {
                const monthsDiff = now.diff(lastUpdated, 'months');

                if (monthsDiff > 0) {
                    balance += monthsDiff * 2;
                    db.run('UPDATE users SET leave_balance = ?, leave_balance_last_updated = ? WHERE name = ?',
                        [balance, now.format('YYYY-MM'), username],
                        (updateErr) => {
                            if (updateErr) return reject(updateErr);
                            resolve(balance);
                        });
                } else {
                    resolve(balance);
                }
            }
        });
    });
}

// --- AUTHENTICATION & MIDDLEWARE ---
function requireLogin ( req, res, next )
{
    if ( req.session.user )
    {
        next();
    } else
    {
        res.redirect( '/' );
    }
}

function requireAdmin ( req, res, next )
{
    if ( req.session.user && ( req.session.user.role === 'owner_admin' || req.session.user.role === 'employee_admin' ) )
    {
        next();
    } else
    {
        res.status( 403 ).send( 'Access Denied' );
    }
}

// --- GENERAL & LOGIN ROUTES ---
app.get( '/', ( req, res ) =>
{
    res.sendFile( path.join( __dirname, 'login.html' ) );
} );

app.post( '/login', ( req, res ) =>
{
    const { name, password } = req.body;
    db.get( 'SELECT * FROM users WHERE name = ? AND password = ?', [ name, password ], ( err, user ) =>
    {
        if ( err )
        {
            return console.error( err.message );
        }
        if ( user )
        {
            req.session.user = user;
            if ( user.role === 'owner_admin' )
            {
                res.redirect( '/admin' );
            } else
            {
                res.redirect( '/dashboard' );
            }
        } else
        {
            res.send( 'Invalid credentials' );
        }
    } );
} );

app.get( '/logout', ( req, res ) =>
{
    req.session.destroy( () =>
    {
        res.redirect( '/' );
    } );
} );

app.get( '/user/me', requireLogin, ( req, res ) =>
{
    res.json( req.session.user );
} );

// --- EMPLOYEE ROUTES ---
app.get( '/dashboard', requireLogin, ( req, res ) =>
{
    if ( req.session.user.role === 'owner_admin' ) return res.redirect( '/admin' );
    res.sendFile( path.join( __dirname, 'dashboard.html' ) );
} );

app.get( '/attendance/status', requireLogin, ( req, res ) =>
{
    const user = req.session.user;
    const today = moment().format( 'YYYY-MM-DD' );
    db.get( `SELECT * FROM attendance_${ user.name } WHERE date = ?`, [ today ], ( err, row ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        if ( !row ) return res.json( { status: 'not_marked_in' } );
        if ( row.in_time && !row.out_time ) return res.json( { status: 'marked_in' } );
        if ( row.in_time && row.out_time ) return res.json( { status: 'marked_out' } );
    } );
} );

app.post( '/mark-in', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = moment();
    const date = now.format( 'YYYY-MM-DD' );
    const time = now.format( 'HH:mm:ss' );
    const selfiePath = path.join( selfiesDir, user.name, `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_in.jpg` );
    const base64Data = selfie.replace( /^data:image\/jpeg;base64,/, "" );
    fs.writeFile( selfiePath, base64Data, 'base64', ( err ) => { if ( err ) console.error( err ); } );
    db.run( `INSERT INTO attendance_${ user.name } (date, in_time, in_latitude, in_longitude, in_selfie_path) VALUES (?, ?, ?, ?, ?)`,
        [ date, time, latitude, longitude, selfiePath ], function ( err )
    {
        if ( err ) return console.error( err.message );
        console.log( `${ user.name } marked in on ${ now.format( 'DD-MMMM-YYYY' ) } at ${ now.format( 'h:mm A' ) }` );
        res.redirect( '/dashboard' );
    } );
} );

app.post( '/mark-out', requireLogin, ( req, res ) =>
{
    const { latitude, longitude, selfie } = req.body;
    const user = req.session.user;
    const now = moment();
    const date = now.format( 'YYYY-MM-DD' );
    const time = now.format( 'HH:mm:ss' );
    const selfiePath = path.join( selfiesDir, user.name, `${ user.name }_${ date }_${ time.replace( /:/g, '-' ) }_out.jpg` );
    const base64Data = selfie.replace( /^data:image\/jpeg;base64,/, "" );
    fs.writeFile( selfiePath, base64Data, 'base64', ( err ) => { if ( err ) console.error( err ); } );
    db.run( `UPDATE attendance_${ user.name } SET out_time = ?, out_latitude = ?, out_longitude = ?, out_selfie_path = ? WHERE date = ?`,
        [ time, latitude, longitude, selfiePath, date ], function ( err )
    {
        if ( err ) return console.error( err.message );
        console.log( `${ user.name } marked out on ${ now.format( 'DD-MMMM-YYYY' ) } at ${ now.format( 'h:mm A' ) }` );
        res.redirect( '/dashboard' );
    } );
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
            out_time: formatTimeForDisplay( row.date, row.out_time )
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

app.post( '/leaves/apply', requireLogin, async ( req, res ) =>
{
    const { start_date, end_date, reason } = req.body;
    const username = req.session.user.name;

    try
    {
        const balance = await calculateAndUpdateLeaveBalance( username );
        const leaveDuration = moment( end_date ).diff( moment( start_date ), 'days' ) + 1;

        if ( balance < leaveDuration )
        {
            return res.status( 400 ).send( 'Insufficient leave balance.' );
        }

        db.run( 'INSERT INTO leaves (username, start_date, end_date, reason) VALUES (?, ?, ?, ?)',
            [ username, start_date, end_date, reason ], function ( err )
        {
            if ( err ) return res.status( 500 ).send( 'Error applying for leave.' );
            console.log( `${ username } applied for leave from ${ moment( start_date, 'YYYY-MM-DD' ).format( 'DD-MMMM-YYYY' ) } to ${ moment( end_date, 'YYYY-MM-DD' ).format( 'DD-MMMM-YYYY' ) }` );
            res.redirect( '/dashboard' );
        } );
    } catch ( error )
    {
        res.status( 500 ).send( error.message );
    }
} );

app.get( '/leaves', requireLogin, ( req, res ) =>
{
    db.all( 'SELECT * FROM leaves WHERE username = ? ORDER BY start_date DESC', [ req.session.user.name ], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row => ( {
            ...row,
            start_date: formatDateForDisplay( row.start_date ),
            end_date: formatDateForDisplay( row.end_date )
        } ) );
        res.json( formattedRows );
    } );
} );

// --- ADMIN ROUTES ---
app.get( '/admin', requireAdmin, ( req, res ) =>
{
    res.sendFile( path.join( __dirname, 'admin.html' ) );
} );

app.get( '/admin/users', requireAdmin, ( req, res ) =>
{
    db.all( 'SELECT name, role FROM users', [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        res.json( rows );
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
            out_time: formatTimeForDisplay( row.date, row.out_time )
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
        if ( user.role === 'employee_admin' )
        {
            // Employee admin sees only leaves from regular employees
            filteredRows = rows.filter( row => row.role === 'employee' );
        }

        const formattedRows = filteredRows.map( row => ( {
            ...row,
            start_date: formatDateForDisplay( row.start_date ),
            end_date: formatDateForDisplay( row.end_date )
        } ) );

        res.json( formattedRows );
    } );
} );

app.get( '/admin/leaves/history', requireAdmin, ( req, res ) =>
{
    db.all( "SELECT * FROM leaves ORDER BY start_date DESC", [], ( err, rows ) =>
    {
        if ( err ) return res.status( 500 ).json( { error: err.message } );
        const formattedRows = rows.map( row => ( {
            ...row,
            start_date: formatDateForDisplay( row.start_date ),
            end_date: formatDateForDisplay( row.end_date )
        } ) );
        res.json( formattedRows );
    } );
} );

app.post( '/admin/leaves/action', requireAdmin, ( req, res ) =>
{
    const { leave_id, status } = req.body;
    const admin = req.session.user;

    db.get( 'SELECT l.*, u.role FROM leaves l JOIN users u ON l.username = u.name WHERE l.leave_id = ?', [ leave_id ], ( err, leave ) =>
    {
        if ( err || !leave ) return res.status( 404 ).send( 'Leave not found.' );

        // Check permissions
        if ( admin.role === 'employee_admin' && leave.role !== 'employee' )
        {
            return res.status( 403 ).send( 'You are not authorized to action this leave request.' );
        }

        if ( admin.role !== 'owner_admin' && leave.role === 'employee_admin' )
        {
            return res.status( 403 ).send( 'Only the Owner Admin can action this leave request.' );
        }

        if ( status === 'approved' )
        {
            const leaveDuration = moment( leave.end_date ).diff( moment( leave.start_date ), 'days' ) + 1;
            db.run( 'UPDATE users SET leave_balance = leave_balance - ? WHERE name = ?', [ leaveDuration, leave.username ] );
        }

        db.run( 'UPDATE leaves SET status = ?, approved_by = ? WHERE leave_id = ?', [ status, admin.name, leave_id ], function ( err )
        {
            if ( err ) return res.status( 500 ).send( 'Error processing leave request.' );
            console.log( `${ admin.name } ${ status } leave for ${ leave.username } from dates ${ moment( leave.start_date, 'YYYY-MM-DD' ).format( 'DD-MMMM-YYYY' ) } to ${ moment( leave.end_date, 'YYYY-MM-DD' ).format( 'DD-MMMM-YYYY' ) }` );
            res.sendStatus( 200 );
        } );
    } );
} );

// --- SERVER START ---
app.listen( port, () =>
{
    console.log( `Server listening at http://localhost:${ port }` );
} );