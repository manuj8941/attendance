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
            const promise = tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    if ( callback ) callback.call( { lastID: result.lastInsertRowid, changes: result.rowsAffected }, null );
                    return result;
                } )
                .catch( err =>
                {
                    if ( callback ) callback.call( {}, err );
                    else console.error( 'Turso run error:', err );
                    throw err;
                } );

            // Return promise if no callback (for async/await)
            return callback ? undefined : promise;
        },

        get ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];
            const promise = tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    const row = result.rows[ 0 ] || null;
                    if ( callback ) callback( null, row );
                    return row;
                } )
                .catch( err =>
                {
                    if ( callback ) callback( err, null );
                    else console.error( 'Turso get error:', err );
                    throw err;
                } );

            // Return promise if no callback (for async/await)
            return callback ? undefined : promise;
        },

        all ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];
            const promise = tursoClient.execute( { sql, args: paramsArray } )
                .then( result =>
                {
                    if ( callback ) callback( null, result.rows );
                    return result.rows;
                } )
                .catch( err =>
                {
                    if ( callback ) callback( err, [] );
                    else console.error( 'Turso all error:', err );
                    throw err;
                } );

            // Return promise if no callback (for async/await)
            return callback ? undefined : promise;
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

    const sqliteDb = new sqlite3.Database( './attendance.db', ( err ) =>
    {
        if ( err )
        {
            console.error( err.message );
        }
        console.log( '💾 Connected to local SQLite database (attendance.db)' );
    } );

    // Wrap SQLite to support both callback and promise-based usage (matching Turso interface)
    db = {
        _sqliteDb: sqliteDb,
        _isTurso: false,

        run ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];

            if ( callback )
            {
                // Callback mode
                return sqliteDb.run( sql, paramsArray, callback );
            }
            else
            {
                // Promise mode (for async/await)
                return new Promise( ( resolve, reject ) =>
                {
                    sqliteDb.run( sql, paramsArray, function ( err )
                    {
                        if ( err ) reject( err );
                        else resolve( { lastID: this.lastID, changes: this.changes } );
                    } );
                } );
            }
        },

        get ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];

            if ( callback )
            {
                return sqliteDb.get( sql, paramsArray, callback );
            }
            else
            {
                return new Promise( ( resolve, reject ) =>
                {
                    sqliteDb.get( sql, paramsArray, ( err, row ) =>
                    {
                        if ( err ) reject( err );
                        else resolve( row );
                    } );
                } );
            }
        },

        all ( sql, params, callback )
        {
            const paramsArray = Array.isArray( params ) ? params : [];

            if ( callback )
            {
                return sqliteDb.all( sql, paramsArray, callback );
            }
            else
            {
                return new Promise( ( resolve, reject ) =>
                {
                    sqliteDb.all( sql, paramsArray, ( err, rows ) =>
                    {
                        if ( err ) reject( err );
                        else resolve( rows );
                    } );
                } );
            }
        },

        exec ( sql, callback )
        {
            if ( callback )
            {
                return sqliteDb.exec( sql, callback );
            }
            else
            {
                return new Promise( ( resolve, reject ) =>
                {
                    sqliteDb.exec( sql, ( err ) =>
                    {
                        if ( err ) reject( err );
                        else resolve();
                    } );
                } );
            }
        },

        serialize ( callback )
        {
            return sqliteDb.serialize( callback );
        },

        prepare ( sql )
        {
            const statement = sqliteDb.prepare( sql );
            return {
                _statement: statement,
                run ( ...args )
                {
                    const callback = typeof args[ args.length - 1 ] === 'function' ? args.pop() : null;
                    const params = args;

                    if ( callback )
                    {
                        return statement.run( params, callback );
                    }
                    else
                    {
                        return new Promise( ( resolve, reject ) =>
                        {
                            statement.run( params, function ( err )
                            {
                                if ( err ) reject( err );
                                else resolve( { lastID: this.lastID, changes: this.changes } );
                            } );
                        } );
                    }
                },
                finalize ( callback )
                {
                    if ( callback )
                    {
                        return statement.finalize( callback );
                    }
                    else
                    {
                        return new Promise( ( resolve, reject ) =>
                        {
                            statement.finalize( ( err ) =>
                            {
                                if ( err ) reject( err );
                                else resolve();
                            } );
                        } );
                    }
                }
            };
        }
    };
}

module.exports = { db, useTurso };
