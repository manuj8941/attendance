// Bottom Navigation Component
// Auto-generates navigation based on user role and current page

function initBottomNav ( currentPage, userRole )
{
    // Define navigation items for each role
    const navItems = {
        owner: [
            { page: 'admin', icon: 'fa-user-shield', href: '/admin', title: 'Team' },
            { page: 'appsettings', icon: 'fa-cog', href: '/appsettings', title: 'Settings' },
            { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
            { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
            { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
        ],
        manager: [
            { page: 'dashboard', icon: 'fa-home', href: '/dashboard', title: 'Home' },
            { page: 'admin', icon: 'fa-user-shield', href: '/admin', title: 'Team' },
            { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
            { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
            { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
        ],
        employee: [
            { page: 'dashboard', icon: 'fa-home', href: '/dashboard', title: 'Home' },
            { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
            { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
            { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
        ]
    };

    const items = navItems[ userRole ] || navItems.employee;

    // Create bottom nav HTML
    const navHtml = `
        <nav class="bottom-nav">
            <div class="bottom-nav-container">
                ${ items.map( item => `
                    <a href="${ item.href }" class="bottom-nav-item ${ item.page === currentPage ? 'active' : '' }" title="${ item.title }">
                        <i class="fas ${ item.icon }"></i>
                    </a>
                `).join( '' ) }
            </div>
        </nav>
    `;

    // Append to body
    document.body.insertAdjacentHTML( 'beforeend', navHtml );
}
