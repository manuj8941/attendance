// Database connection abstraction - supports both local SQLite and Turso
// Automatically switches based on environment variables

const useTurso = !!process.env.TURSO_DATABASE_URL && !!process.env.TURSO_AUTH_TOKEN;

let db;

if ( useTurso )
{
    // Use Turso for production
    const { createClient } = require( '@libsql/client' );

    const tursoClient = createClient( {
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    } );

    console.log( '☁️  Using Turso database (cloud SQLite)' );

    // Wrapper to provide sqlite3-like interface
    db = {
        _tursoClient: tursoClient,
        _isTurso: true,

        run ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];
            tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    if ( callback ) callback.call( { lastID: result.lastInsertRowid, changes: result.rowsAffected }, null );
                } )
                .catch( err =>
                {
                    if ( callback ) callback.call( {}, err );
                    else console.error( 'Turso run error:', err );
                } );
        },

        get ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];
            tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    const row = result.rows[ 0 ] || null;
                    if ( callback ) callback( null, row );
                } )
                .catch( err =>
                {
                    if ( callback ) callback( err, null );
                    else console.error( 'Turso get error:', err );
                } );
        },

        all ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];
            tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    if ( callback ) callback( null, result.rows );
                } )
                .catch( err =>
                {
                    if ( callback ) callback( err, [] );
                    else console.error( 'Turso all error:', err );
                } );
        },

        serialize ( callback )
        {
            // Turso doesn't need serialization, execute callback immediately
            if ( callback ) callback();
        },

        prepare ( sql )
        {
            // Return a statement-like object
            const statement = {
                _sql: sql,
                run ( ...args )
                {
                    const callback = typeof args[ args.length - 1 ] === 'function' ? args.pop() : null;
                    const params = args;
                    db.run( sql, params, callback );
                },
                finalize ( callback )
                {
                    if ( callback ) callback();
                }
            };
            return statement;
        }
    };
}
else
{
    // Use local SQLite for development
    const sqlite3 = require( 'sqlite3' ).verbose();

    db = new sqlite3.Database( './attendance.db', ( err ) =>
    {
        if ( err )
        {
            console.error( err.message );
        }
        console.log( '💾 Connected to local SQLite database (attendance.db)' );
    } );
}

module.exports = { db, useTurso };
