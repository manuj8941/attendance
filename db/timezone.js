const moment = require( 'moment-timezone' );

// Cache for timezone setting to avoid repeated DB queries
let cachedTimezone = 'Asia/Kolkata';

/**
 * Get timezone-aware moment instance
 * Uses the configured timezone from settings
 * @returns {moment.Moment} Moment instance in the configured timezone
 */
function getMoment ()
{
    return moment.tz( cachedTimezone );
}

/**
 * Set the timezone cache
 * Called by settings module after loading from database
 * @param {string} timezone - IANA timezone identifier
 */
function setCachedTimezone ( timezone )
{
    if ( timezone && moment.tz.zone( timezone ) )
    {
        cachedTimezone = timezone;
        console.log( 'Loaded timezone:', cachedTimezone );
    } else
    {
        cachedTimezone = 'Asia/Kolkata';
        console.log( 'Using default timezone:', cachedTimezone );
    }
}

/**
 * Get current timezone
 * @returns {string} Current cached timezone
 */
function getTimezone ()
{
    return cachedTimezone;
}

module.exports = { getMoment, setCachedTimezone, getTimezone };
