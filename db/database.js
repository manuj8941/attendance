const sqlite3 = require( 'sqlite3' ).verbose();
const bcrypt = require( 'bcryptjs' );
const moment = require( 'moment-timezone' );
const { users } = require( './seed' );
const { getMoment } = require( './timezone' );
const SALT_ROUNDS = 10;

// Initialize database connection
const db = new sqlite3.Database( './attendance.db', ( err ) =>
{
    if ( err )
    {
        console.error( err.message );
    }
    console.log( 'Connected to the attendance database.' );
} );

// Database initialization function
function initializeDatabase ( app, accrueLeavesCallback )
{
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
        } );

        const stmtUsers = db.prepare( 'INSERT OR IGNORE INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)' );
        users.forEach( user =>
        {
            try
            {
                const pwdHash = bcrypt.hashSync( ( user.password || '' ).toString(), SALT_ROUNDS );
                const normalized = user.name.toLowerCase().replace( /[.\-_\s]/g, '' );
                const joinDate = user.join_date || getMoment().format( 'YYYY-MM-DD' );
                stmtUsers.run( normalized, pwdHash, user.role, joinDate );
            } catch ( e )
            {
                console.error( 'Error hashing seed password for', user.name, e );
                const normalized = user.name.toLowerCase().replace( /[.\-_\s]/g, '' );
                const joinDate = user.join_date || getMoment().format( 'YYYY-MM-DD' );
                stmtUsers.run( normalized, user.password, user.role, joinDate );
            }
        } );
        stmtUsers.finalize();

        // Ensure optional column exists on `users` for single-session mapping
        db.all( "PRAGMA table_info(users)", [], ( prErrU, ucols ) =>
        {
            if ( prErrU ) return;
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
            {
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

        // Ensure optional columns exist on `leaves`
        db.all( "PRAGMA table_info(leaves)", [], ( prErr, cols ) =>
        {
            if ( prErr ) return;
            try
            {
                const names = ( cols || [] ).map( c => c.name );
                if ( names.indexOf( 'is_backdated' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN is_backdated INTEGER DEFAULT 0" );
                if ( names.indexOf( 'taken_back' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN taken_back INTEGER DEFAULT 0" );
                if ( names.indexOf( 'taken_back_at' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN taken_back_at TEXT DEFAULT ''" );
            } catch ( e ) { /* ignore migration errors */ }
        } );

        // Settings table
        db.run( "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT)", ( err ) =>
        {
            if ( err ) console.error( 'Error creating settings table', err && err.message );
            else
            {
                db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_enabled', '1' ] );
                db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_disabled_at', '' ] );
                db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'test_date_override', '' ] );
                db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'timezone', 'Asia/Kolkata' ] );
            }
        } );

        // Ad-hoc off days table
        db.run( `CREATE TABLE IF NOT EXISTS ad_hoc_offs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT UNIQUE,
            reason TEXT,
            created_by TEXT,
            created_at TEXT
        )` );

        // Yearly holidays table
        db.run( `CREATE TABLE IF NOT EXISTS holidays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            month_day TEXT,
            date TEXT
        )` );

        // Weekly off mode (default: mode 3 = All Sundays + 2nd & 4th Saturdays)
        db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'weekly_off_mode', '3' ] );

        // Branding settings
        db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'company_logo', '' ] );
        db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'brand_color', '#0ea5a4' ] );
        db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'company_name', 'Attendance System' ] );

        // Server startup leave accrual
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
                    await accrueLeavesCallback( employee );
                } catch ( error )
                {
                    console.error( `Error during startup leave accrual for ${ employee.name }:`, error.message );
                }
            }
            console.log( 'Initial leave accrual on startup completed.' );
        } );

        // Load global test-date override
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
}

// Export database connection and initialization
module.exports = { db, users, initializeDatabase };
