const { db } = require( './database' );

/**
 * Get a setting value by name
 * @param {string} name - Setting name
 * @returns {Promise<string>} Setting value or empty string if not found
 */
function getSetting ( name )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT value FROM settings WHERE name = ?', [ name ], ( err, row ) =>
        {
            if ( err ) return reject( err );
            resolve( ( row && row.value ) ? row.value : '' );
        } );
    } );
}

/**
 * Update or insert a setting value
 * @param {string} name - Setting name
 * @param {string} value - Setting value
 * @returns {Promise<void>}
 */
function updateSetting ( name, value )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.run( 'INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)', [ name, value ], function ( err )
        {
            if ( err ) return reject( err );
            resolve();
        } );
    } );
}

/**
 * Get multiple settings at once
 * @param {string[]} names - Array of setting names
 * @returns {Promise<Object>} Object with setting names as keys
 */
async function getSettings ( names )
{
    const result = {};
    for ( const name of names )
    {
        try
        {
            result[ name ] = await getSetting( name );
        } catch ( e )
        {
            result[ name ] = '';
        }
    }
    return result;
}

module.exports = { getSetting,    updateSetting,    getSettings};
