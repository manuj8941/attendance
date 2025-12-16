const sharp = require( 'sharp' );
const fs = require( 'fs' );
const path = require( 'path' );

const svgPath = path.join( __dirname, 'public', 'icons', 'icon.svg' );
const outputDir = path.join( __dirname, 'public', 'icons' );

async function generateIcons ()
{
    const svgBuffer = fs.readFileSync( svgPath );

    // Generate 192x192 icon
    await sharp( svgBuffer )
        .resize( 192, 192 )
        .png()
        .toFile( path.join( outputDir, 'icon-192.png' ) );
    console.log( '✅ Generated icon-192.png' );

    // Generate 512x512 icon
    await sharp( svgBuffer )
        .resize( 512, 512 )
        .png()
        .toFile( path.join( outputDir, 'icon-512.png' ) );
    console.log( '✅ Generated icon-512.png' );

    // Generate 512x512 maskable icon (with padding for safe zone)
    await sharp( svgBuffer )
        .resize( 410, 410 )
        .extend( {
            top: 51,
            bottom: 51,
            left: 51,
            right: 51,
            background: { r: 14, g: 165, b: 164, alpha: 1 }
        } )
        .png()
        .toFile( path.join( outputDir, 'icon-512-maskable.png' ) );
    console.log( '✅ Generated icon-512-maskable.png' );

    // Generate favicon sizes
    await sharp( svgBuffer )
        .resize( 32, 32 )
        .png()
        .toFile( path.join( outputDir, 'favicon-32.png' ) );
    console.log( '✅ Generated favicon-32.png' );

    await sharp( svgBuffer )
        .resize( 16, 16 )
        .png()
        .toFile( path.join( outputDir, 'favicon-16.png' ) );
    console.log( '✅ Generated favicon-16.png' );

    console.log( '\n🎉 All icons generated successfully!' );
}

generateIcons().catch( console.error );
