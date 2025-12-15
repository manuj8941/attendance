// Seed data for initial database setup
// Configure via environment variables for deployment

require( 'dotenv' ).config( { quiet: true } );

// Parse seed users from environment variable
// Format: SEED_USERS=name:password:role:join_date,name:password:role:join_date,...
// Example: SEED_USERS=smita:pass123:owner:2025-12-01,dinesh:pass456:manager:2025-12-01
function parseSeedUsers ()
{
    const seedUsersEnv = process.env.SEED_USERS;

    if ( seedUsersEnv )
    {
        try
        {
            return seedUsersEnv.split( ',' ).map( userStr =>
            {
                const [ name, password, role, join_date ] = userStr.trim().split( ':' );
                if ( !name || !password || !role || !join_date )
                {
                    throw new Error( `Invalid SEED_USERS format: ${ userStr }` );
                }
                return { name, password, role, join_date };
            } );
        } catch ( err )
        {
            console.error( 'Error parsing SEED_USERS:', err.message );
            console.error( 'Using default seed users instead' );
        }
    }

    // Default seed users if SEED_USERS env var is not set
    return [
        { name: 'smita', password: '111', role: 'owner', join_date: '2025-12-01' },
        { name: 'dinesh', password: '111', role: 'manager', join_date: '2025-12-01' },
        { name: 'manuj', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'atul', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'kamini', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'nazmul', password: '111', role: 'employee', join_date: '2025-12-01' }
    ];
}

const users = parseSeedUsers();

module.exports = { users };
