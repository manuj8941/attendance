require( 'dotenv' ).config( { quiet: true } );
const { createClient } = require( '@libsql/client' );

const client = createClient( {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
} );

client.execute( 'SELECT * FROM holidays' )
    .then( result =>
    {
        console.log( 'Holidays in database:' );
        console.log( JSON.stringify( result.rows, null, 2 ) );
        process.exit( 0 );
    } )
    .catch( err =>
    {
        console.error( 'Error:', err );
        process.exit( 1 );
    } );
