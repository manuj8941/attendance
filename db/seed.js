// Seed data for initial database setup
// Modify this file to customize default users before deployment

const users =
    [
        { name: 'smita', password: '111', role: 'owner' },
        { name: 'dinesh', password: '111', role: 'manager' },
        { name: 'manuj', password: '111', role: 'employee' },
        { name: 'atul', password: '111', role: 'employee' },
        { name: 'kamini', password: '111', role: 'employee' },
        { name: 'nazmul', password: '111', role: 'employee' }
    ];

module.exports =
{
    users
};
