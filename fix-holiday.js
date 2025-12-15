require( 'dotenv' ).config( { quiet: true } );
const { createClient } = require( '@libsql/client' );

const client = createClient( {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
} );

// Fix holiday ID 2 - remove month_day so it's truly non-recurring
client.execute( 'UPDATE holidays SET month_day = NULL WHERE id = 2' )
    .then( () =>
    {
        console.log( '✅ Fixed holiday ID 2 - removed month_day, now non-recurring' );
        return client.execute( 'SELECT * FROM holidays' );
    } )
    .then( result =>
    {
        console.log( '\nHolidays after fix:' );
        console.log( JSON.stringify( result.rows, null, 2 ) );
        process.exit( 0 );
    } )
    .catch( err =>
    {
        console.error( 'Error:', err );
        process.exit( 1 );
    } );
