// Clean Turso database and R2 storage - removes all tables and files but keeps database/bucket
require( 'dotenv' ).config( { quiet: true } );
const { createClient } = require( '@libsql/client' );
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require( '@aws-sdk/client-s3' );

async function cleanR2Storage ()
{
    if ( !process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET_NAME )
    {
        console.log( '\n⚠️  Skipping R2 cleanup - missing credentials in .env file' );
        return;
    }

    const r2Client = new S3Client( {
        region: 'auto',
        endpoint: `https://${ process.env.R2_ACCOUNT_ID }.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    } );

    try
    {
        console.log( '\n🔍 Fetching all files from R2 bucket...' );

        // List all objects in the bucket
        const listCommand = new ListObjectsV2Command( {
            Bucket: process.env.R2_BUCKET_NAME
        } );

        const listResult = await r2Client.send( listCommand );

        if ( !listResult.Contents || listResult.Contents.length === 0 )
        {
            console.log( '✅ R2 bucket is already clean (no files found)' );
            return;
        }

        const files = listResult.Contents.map( obj => obj.Key );
        console.log( `\n📋 Found ${ files.length } files:` );
        files.forEach( file => console.log( `   - ${ file }` ) );

        console.log( `\n🗑️  Deleting all files from R2...` );

        // Delete all objects (up to 1000 at once)
        const deleteCommand = new DeleteObjectsCommand( {
            Bucket: process.env.R2_BUCKET_NAME,
            Delete: {
                Objects: files.map( key => ( { Key: key } ) ),
                Quiet: false
            }
        } );

        const deleteResult = await r2Client.send( deleteCommand );

        console.log( `\n✅ Successfully cleaned R2 bucket!` );
        console.log( `   Deleted ${ files.length } files` );
        if ( deleteResult.Deleted )
        {
            deleteResult.Deleted.forEach( obj => console.log( `   ✓ Deleted: ${ obj.Key }` ) );
        }

    } catch ( error )
    {
        console.error( '❌ Error cleaning R2 storage:', error.message );
    }
}

async function cleanTursoDatabase ()
{
    if ( !process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN )
    {
        console.error( '❌ Missing Turso credentials in .env file' );
        console.log( 'Required: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN' );
        process.exit( 1 );
    }

    const client = createClient( {
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    } );

    try
    {
        console.log( '🔍 Fetching all tables from Turso database...' );

        // Get all table names
        const result = await client.execute( `
            SELECT name FROM sqlite_master 
            WHERE type='table' 
            AND name NOT LIKE 'sqlite_%' 
            AND name NOT LIKE '_litestream_%'
            ORDER BY name
        ` );

        const tables = result.rows.map( row => row.name );

        if ( tables.length === 0 )
        {
            console.log( '✅ Database is already clean (no tables found)' );
            return;
        }

        console.log( `\n📋 Found ${ tables.length } tables:` );
        tables.forEach( table => console.log( `   - ${ table }` ) );

        console.log( `\n🗑️  Dropping all tables...` );

        // Drop each table
        for ( const table of tables )
        {
            await client.execute( `DROP TABLE IF EXISTS ${ table }` );
            console.log( `   ✓ Dropped: ${ table }` );
        }

        console.log( `\n✅ Successfully cleaned Turso database!` );
        console.log( `   Dropped ${ tables.length } tables` );
        console.log( `   Database is ready for fresh initialization` );

    } catch ( error )
    {
        console.error( '❌ Error cleaning database:', error.message );
        process.exit( 1 );
    }
}

async function main ()
{
    console.log( '🧹 Starting cleanup of Turso database and R2 storage...\n' );

    await cleanTursoDatabase();
    await cleanR2Storage();

    console.log( '\n🎉 Cleanup complete! Both database and storage are clean.' );
}

main();
