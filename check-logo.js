require( 'dotenv' ).config( { quiet: true } );
const { createClient } = require( '@libsql/client' );

const client = createClient( {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
} );

client.execute( 'SELECT value FROM settings WHERE name = "company_logo"' )
    .then( result =>
    {
        const logoPath = result.rows[ 0 ]?.value || 'NOT SET';
        console.log( 'Logo path in database:', logoPath );
        process.exit( 0 );
    } )
    .catch( err =>
    {
        console.error( 'Error:', err );
        process.exit( 1 );
    } );
