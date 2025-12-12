const { db } = require( './database' );
const moment = require( 'moment-timezone' );
const { setCachedTimezone } = require( './timezone' );

/**
 * Initialize timezone cache from database
 * Should be called during app startup
 */
function initTimezone ()
{
    getSetting( 'timezone' ).then( tz =>
    {
        setCachedTimezone( tz );
    } ).catch( () =>
    {
        setCachedTimezone( '' );
    } );
}

/**
 * Update timezone setting and refresh cache
 * @param {string} timezone - IANA timezone identifier
 */
async function updateTimezone ( timezone )
{
    if ( !moment.tz.zone( timezone ) )
    {
        throw new Error( 'Invalid timezone' );
    }
    await updateSetting( 'timezone', timezone );
    setCachedTimezone( timezone );
    console.log( 'Timezone updated to:', timezone );
}

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

module.exports = { getSetting, updateSetting, getSettings, initTimezone, updateTimezone };
