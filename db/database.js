const { db, useTurso } = require( './connection' );
const bcrypt = require( 'bcryptjs' );
const moment = require( 'moment-timezone' );
const { users } = require( './seed' );
const { getMoment } = require( './timezone' );
const SALT_ROUNDS = 10;

// Database initialization function
async function initializeDatabase ( app, accrueLeavesCallback )
{
    if ( useTurso )
    {
        // Turso async initialization
        await initializeDatabaseAsync( app, accrueLeavesCallback );
    }
    else
    {
        // SQLite callback-based initialization (existing code)
        initializeDatabaseSync( app, accrueLeavesCallback );
    }
}

// Async initialization for Turso
async function initializeDatabaseAsync ( app, accrueLeavesCallback )
{
    try
    {
        console.log( '🔧 Initializing Turso database...' );

        // Check which core tables exist before creation
        const tableCheckQuery = "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'leaves', 'settings', 'ad_hoc_offs', 'holidays')";
        const existingTables = await db.all( tableCheckQuery );
        const existingTableNames = existingTables.map( t => t.name );

        const allCoreTablesExist = existingTableNames.length === 5; // All 5 core tables

        // Users table
        await db.run( 'CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, password TEXT, role TEXT, leave_balance REAL DEFAULT 0, leave_balance_last_updated TEXT, join_date TEXT DEFAULT \'2025-01-01\', current_session_id TEXT DEFAULT \'\', profile_picture TEXT)' );

        // Ensure current_session_id and profile_picture columns exist (migration for existing tables)
        const userColumns = await db.all( "PRAGMA table_info(users)" );
        const userColumnNames = userColumns.map( c => c.name );
        if ( !userColumnNames.includes( 'current_session_id' ) )
        {
            await db.run( "ALTER TABLE users ADD COLUMN current_session_id TEXT DEFAULT ''" );
            console.log( '✅ Added current_session_id column to users table' );
        }
        if ( !userColumnNames.includes( 'profile_picture' ) )
        {
            await db.run( "ALTER TABLE users ADD COLUMN profile_picture TEXT" );
            console.log( '✅ Added profile_picture column to users table' );
        }

        // Insert seed users
        for ( const user of users )
        {
            try
            {
                const pwdHash = bcrypt.hashSync( ( user.password || '' ).toString(), SALT_ROUNDS );
                const normalized = user.name.toLowerCase().replace( /[.\-_\s]/g, '' );
                const joinDate = user.join_date || getMoment().format( 'YYYY-MM-DD' );
                await db.run( 'INSERT OR IGNORE INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)',
                    [ normalized, pwdHash, user.role, joinDate ] );
            } catch ( e )
            {
                console.error( 'Error hashing seed password for', user.name, e );
                const normalized = user.name.toLowerCase().replace( /[.\-_\s]/g, '' );
                const joinDate = user.join_date || getMoment().format( 'YYYY-MM-DD' );
                await db.run( 'INSERT OR IGNORE INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)',
                    [ normalized, user.password, user.role, joinDate ] );
            }
        }

        // Attendance tables (one per non-owner user)
        for ( const user of users )
        {
            if ( user.role !== 'owner' )
            {
                const normalized = user.name.toLowerCase().replace( /[.\-_\s]/g, '' );
                await db.run( `CREATE TABLE IF NOT EXISTS attendance_${ normalized } (
                    date TEXT PRIMARY KEY, 
                    in_time TEXT, in_latitude REAL, in_longitude REAL, in_selfie_path TEXT,
                    out_time TEXT, out_latitude REAL, out_longitude REAL, out_selfie_path TEXT
                )` );
            }
        }

        // Leaves table
        await db.run( `CREATE TABLE IF NOT EXISTS leaves (
            leave_id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            start_date TEXT,
            end_date TEXT,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            approved_by TEXT,
            is_backdated INTEGER DEFAULT 0,
            taken_back INTEGER DEFAULT 0,
            taken_back_at TEXT DEFAULT '',
            leave_type TEXT DEFAULT 'full'
        )` );

        // Ensure optional columns exist on leaves table (migrations)
        const leavesColumnInfo = await db.all( "PRAGMA table_info(leaves)" );
        const existingLeavesColumns = leavesColumnInfo.map( c => c.name );

        const leavesColumnsToAdd = [
            { name: 'is_backdated', def: 'is_backdated INTEGER DEFAULT 0' },
            { name: 'taken_back', def: 'taken_back INTEGER DEFAULT 0' },
            { name: 'taken_back_at', def: 'taken_back_at TEXT DEFAULT \'\'' },
            { name: 'leave_type', def: 'leave_type TEXT DEFAULT \'full\'' }
        ];

        for ( const col of leavesColumnsToAdd )
        {
            if ( !existingLeavesColumns.includes( col.name ) )
            {
                await db.run( `ALTER TABLE leaves ADD COLUMN ${ col.def }` );
                console.log( `✅ Added ${ col.name } column to leaves table` );
            }
        }

        // Settings table
        await db.run( "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT)" );

        // Insert default settings
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_enabled', '1' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'desktop_disabled_at', '' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'test_date_override', '' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'timezone', 'Asia/Kolkata' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'weekly_off_mode', '3' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'company_logo', '' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'brand_color', '#0ea5a4' ] );
        await db.run( "INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)", [ 'company_name', 'Attendance System' ] );

        // Ad-hoc off days table
        await db.run( `CREATE TABLE IF NOT EXISTS ad_hoc_offs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT UNIQUE,
            reason TEXT,
            created_by TEXT,
            created_at TEXT
        )` );

        // Yearly holidays table
        await db.run( `CREATE TABLE IF NOT EXISTS holidays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            month_day TEXT,
            date TEXT
        )` );

        if ( allCoreTablesExist )
        {
            console.log( '✅ Turso database schema verified (all tables exist)' );
        }
        else if ( existingTableNames.length === 0 )
        {
            console.log( '✅ Turso database tables created successfully (fresh database)' );
        }
        else
        {
            console.log( `✅ Turso database schema updated (created ${ 5 - existingTableNames.length } missing tables)` );
        }

        // Server startup leave accrual
        const employees = await db.all( 'SELECT name, join_date, leave_balance, leave_balance_last_updated FROM users WHERE role != ?', [ 'owner' ] );

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

        // Load global test-date override
        const testDateRow = await db.get( "SELECT value FROM settings WHERE name = ?", [ 'test_date_override' ] );
        const val = ( testDateRow && testDateRow.value ) ? testDateRow.value : '';
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

    } catch ( error )
    {
        console.error( '❌ Error initializing Turso database:', error );
        throw error;
    }
}

// Sync initialization for SQLite (original code)
function initializeDatabaseSync ( app, accrueLeavesCallback )
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

        // Ensure optional columns exist on `users` for single-session mapping and profile pictures
        db.all( "PRAGMA table_info(users)", [], ( prErrU, ucols ) =>
        {
            if ( prErrU ) return;
            try
            {
                const namesU = ( ucols || [] ).map( c => c.name );
                if ( namesU.indexOf( 'current_session_id' ) === -1 ) db.run( "ALTER TABLE users ADD COLUMN current_session_id TEXT DEFAULT ''" );
                if ( namesU.indexOf( 'profile_picture' ) === -1 ) db.run( "ALTER TABLE users ADD COLUMN profile_picture TEXT" );
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
                if ( names.indexOf( 'leave_type' ) === -1 ) db.run( "ALTER TABLE leaves ADD COLUMN leave_type TEXT DEFAULT 'full'" );
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
