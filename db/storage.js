// Storage abstraction layer - supports both local filesystem and Cloudflare R2
// Automatically switches based on environment variables

const fs = require( 'fs' );
const path = require( 'path' );
const { S3Client, PutObjectCommand, GetObjectCommand } = require( '@aws-sdk/client-s3' );

// Determine if we're using cloud storage
const useCloudStorage = !!process.env.R2_ACCOUNT_ID && !!process.env.R2_ACCESS_KEY_ID;

let r2Client = null;

if ( useCloudStorage )
{
    // Initialize R2 client for production
    r2Client = new S3Client( {
        region: 'auto',
        endpoint: `https://${ process.env.R2_ACCOUNT_ID }.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    } );
    console.log( '📦 Using Cloudflare R2 for file storage' );
}
else
{
    console.log( '📁 Using local filesystem for file storage' );
}

/**
 * Save a file (selfie or logo)
 * @param {Buffer} buffer - File data
 * @param {string} filePath - Relative path (e.g., 'selfies/manuj/image.jpg')
 * @returns {Promise<string>} - Public URL or local path
 */
async function saveFile ( buffer, filePath )
{
    if ( useCloudStorage )
    {
        // Upload to R2
        const command = new PutObjectCommand( {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: filePath,
            Body: buffer,
            ContentType: getContentType( filePath )
        } );

        await r2Client.send( command );

        // Return public URL
        return `${ process.env.R2_PUBLIC_URL }/${ filePath }`;
    }
    else
    {
        // Save to local filesystem
        const fullPath = path.join( __dirname, '..', filePath );
        const dir = path.dirname( fullPath );

        // Create directory if it doesn't exist
        if ( !fs.existsSync( dir ) )
        {
            fs.mkdirSync( dir, { recursive: true } );
        }

        fs.writeFileSync( fullPath, buffer );

        // Return local path (will be served by Express static)
        return `/${ filePath.replace( /\\/g, '/' ) }`;
    }
}

/**
 * Delete a file
 * @param {string} filePath - Relative path or URL
 * @returns {Promise<void>}
 */
async function deleteFile ( filePath )
{
    if ( useCloudStorage )
    {
        // Extract key from URL if needed
        const key = filePath.startsWith( 'http' )
            ? filePath.replace( process.env.R2_PUBLIC_URL + '/', '' )
            : filePath;

        // Delete from R2 (implementation optional for now)
        console.log( `Would delete from R2: ${ key }` );
    }
    else
    {
        // Delete from local filesystem
        const fullPath = filePath.startsWith( '/' )
            ? path.join( __dirname, '..', filePath )
            : path.join( __dirname, '..', filePath );

        if ( fs.existsSync( fullPath ) )
        {
            fs.unlinkSync( fullPath );
        }
    }
}

/**
 * Get content type based on file extension
 */
function getContentType ( filePath )
{
    const ext = path.extname( filePath ).toLowerCase();
    const types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
    };
    return types[ ext ] || 'application/octet-stream';
}

module.exports = {
    saveFile,
    deleteFile,
    useCloudStorage
};
