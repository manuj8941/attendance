// Seed data for initial database setup
// Modify this file to customize default users before deployment

const users =
    [
        { name: 'smita', password: '111', role: 'owner', join_date: '2025-12-01' },
        { name: 'dinesh', password: '111', role: 'manager', join_date: '2025-12-01' },
        { name: 'manuj', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'atul', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'kamini', password: '111', role: 'employee', join_date: '2025-12-01' },
        { name: 'nazmul', password: '111', role: 'employee', join_date: '2025-12-01' }
    ];

module.exports = { users };
