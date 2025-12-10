const { db } = require( './database' );
const bcrypt = require( 'bcryptjs' );
const SALT_ROUNDS = 10;

/**
 * Get user by name
 * @param {string} name - Username
 * @returns {Promise<Object|null>} User object or null if not found
 */
function getUserByName ( name )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT * FROM users WHERE name = ?', [ name ], ( err, user ) =>
        {
            if ( err ) return reject( err );
            resolve( user || null );
        } );
    } );
}

/**
 * Get user role by name
 * @param {string} name - Username
 * @returns {Promise<string|null>} User role or null if not found
 */
function getUserRole ( name )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT role FROM users WHERE name = ?', [ name ], ( err, row ) =>
        {
            if ( err ) return reject( err );
            resolve( row ? row.role : null );
        } );
    } );
}

/**
 * Verify user password
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password from database
 * @returns {boolean} True if password matches
 */
function verifyPassword ( password, hashedPassword )
{
    return bcrypt.compareSync( ( password || '' ).toString(), hashedPassword );
}

/**
 * Hash a password
 * @param {string} password - Plain text password
 * @returns {string} Hashed password
 */
function hashPassword ( password )
{
    return bcrypt.hashSync( ( password || '' ).toString(), SALT_ROUNDS );
}

/**
 * Get current session ID for user
 * @param {string} username - Username
 * @returns {Promise<string>} Current session ID or empty string
 */
function getCurrentSessionId ( username )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT current_session_id FROM users WHERE name = ?', [ username ], ( err, row ) =>
        {
            if ( err ) return reject( err );
            resolve( row && row.current_session_id ? row.current_session_id : '' );
        } );
    } );
}

/**
 * Update session ID for user
 * @param {string} username - Username
 * @param {string} sessionId - Session ID to set
 * @returns {Promise<void>}
 */
function updateSessionId ( username, sessionId )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.run( 'UPDATE users SET current_session_id = ? WHERE name = ?', [ sessionId, username ], ( err ) =>
        {
            if ( err ) return reject( err );
            resolve();
        } );
    } );
}

/**
 * Get all users (name and role only)
 * @returns {Promise<Array>} Array of user objects with name and role
 */
function getAllUsers ()
{
    return new Promise( ( resolve, reject ) =>
    {
        db.all( 'SELECT name, role FROM users', [], ( err, rows ) =>
        {
            if ( err ) return reject( err );
            resolve( rows || [] );
        } );
    } );
}

/**
 * Create a new user
 * @param {string} username - Username
 * @param {string} password - Plain text password (will be hashed)
 * @param {string} role - User role
 * @param {string} joinDate - Join date (YYYY-MM-DD)
 * @returns {Promise<void>}
 */
function createUser ( username, password, role, joinDate )
{
    return new Promise( ( resolve, reject ) =>
    {
        const pwdHash = hashPassword( password );
        db.run( 'INSERT INTO users (name, password, role, join_date) VALUES (?, ?, ?, ?)',
            [ username, pwdHash, role, joinDate ],
            function ( err )
            {
                if ( err ) return reject( err );
                resolve();
            } );
    } );
}

/**
 * Update user password
 * @param {string} username - Username
 * @param {string} newPassword - New plain text password (will be hashed)
 * @returns {Promise<void>}
 */
function updatePassword ( username, newPassword )
{
    return new Promise( ( resolve, reject ) =>
    {
        const newHash = hashPassword( newPassword );
        db.run( 'UPDATE users SET password = ? WHERE name = ?', [ newHash, username ], function ( err )
        {
            if ( err ) return reject( err );
            resolve();
        } );
    } );
}

/**
 * Get leave balance for user
 * @param {string} username - Username
 * @returns {Promise<number>} Leave balance
 */
function getLeaveBalance ( username )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.get( 'SELECT leave_balance FROM users WHERE name = ?', [ username ], ( err, user ) =>
        {
            if ( err ) return reject( err );
            if ( !user ) return reject( new Error( 'User not found' ) );
            resolve( parseFloat( user.leave_balance ) || 0 );
        } );
    } );
}

/**
 * Update leave balance for user
 * @param {string} username - Username
 * @param {number} newBalance - New leave balance
 * @param {string} lastUpdated - Last updated month (YYYY-MM)
 * @returns {Promise<void>}
 */
function updateLeaveBalance ( username, newBalance, lastUpdated )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.run( 'UPDATE users SET leave_balance = ?, leave_balance_last_updated = ? WHERE name = ?',
            [ newBalance, lastUpdated, username ],
            ( err ) =>
            {
                if ( err ) return reject( err );
                resolve();
            } );
    } );
}

/**
 * Deduct leave balance from user
 * @param {string} username - Username
 * @param {number} amount - Amount to deduct
 * @returns {Promise<void>}
 */
function deductLeaveBalance ( username, amount )
{
    return new Promise( ( resolve, reject ) =>
    {
        db.run( 'UPDATE users SET leave_balance = leave_balance - ? WHERE name = ?',
            [ amount, username ],
            ( err ) =>
            {
                if ( err ) return reject( err );
                resolve();
            } );
    } );
}

module.exports = {
    getUserByName,
    getUserRole,
    verifyPassword,
    hashPassword,
    getCurrentSessionId,
    updateSessionId,
    getAllUsers,
    createUser,
    updatePassword,
    getLeaveBalance,
    updateLeaveBalance,
    deductLeaveBalance
};
