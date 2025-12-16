// Lightweight modal utility used across pages
( function ()
{
  function ensureModal ()
  {
    if ( document.getElementById( 'app-modal' ) ) return;
    const modal = document.createElement( 'div' );
    modal.id = 'app-modal';
    modal.className = 'modal';
    // enforce overlay positioning so modals always center in viewport (mobile browsers too)
    modal.style.position = 'fixed';
    modal.style.left = '0';
    modal.style.top = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.zIndex = '9999';
    modal.style.display = 'none';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.innerHTML = `
      <div class="modal-content card">
        <p id="app-modal-message" style="margin-top:0"></p>
        <div style="margin-top:12px"><button id="app-modal-ok" class="btn">OK</button></div>
      </div>
    `;
    document.body.appendChild( modal );

    // Don't add static event listeners here - they'll be managed by showAppModal
    // to support callbacks
  }

  function showAppModal ( message, type, onClose )
  {
    ensureModal();
    const modal = document.getElementById( 'app-modal' );
    const msg = document.getElementById( 'app-modal-message' );
    const ok = document.getElementById( 'app-modal-ok' );

    // Add icon based on type
    let icon = '';
    if ( type === 'success' ) icon = '<i class="fas fa-check-circle" style="color:#16a34a;margin-right:8px"></i>';
    else if ( type === 'error' ) icon = '<i class="fas fa-exclamation-triangle" style="color:#dc2626;margin-right:8px"></i>';
    else if ( type === 'info' ) icon = '<i class="fas fa-info-circle" style="color:#0ea5a4;margin-right:8px"></i>';

    msg.innerHTML = icon + ( message || '' );
    msg.className = type === 'success' ? 'status-approved' : ( type === 'error' ? 'status-rejected' : '' );

    // Remove all previous click handlers
    const newOk = ok.cloneNode( true );
    ok.parentNode.replaceChild( newOk, ok );

    // Create new handler that closes modal and calls callback
    const closeHandler = () =>
    {
      modal.style.display = 'none';
      if ( typeof onClose === 'function' )
      {
        try { onClose(); } catch ( e ) { console.error( 'Modal onClose error:', e ); }
      }
    };

    newOk.addEventListener( 'click', closeHandler );

    // Also handle click on overlay to close
    const overlayHandler = ( ev ) =>
    {
      if ( ev.target === modal )
      {
        closeHandler();
      }
    };

    // Remove old overlay listener if exists
    if ( modal._overlayHandler )
    {
      modal.removeEventListener( 'click', modal._overlayHandler );
    }
    modal._overlayHandler = overlayHandler;
    modal.addEventListener( 'click', overlayHandler );

    modal.style.display = 'flex';
  }

  // Promise-based confirm modal. Resolves true if OK clicked, false if cancelled.
  function showAppConfirm ( message, cancelText = 'Cancel', okText = 'OK' )
  {
    return new Promise( ( resolve ) =>
    {
      // Create or reuse an element
      let confirmEl = document.getElementById( 'app-confirm' );
      if ( !confirmEl )
      {
        confirmEl = document.createElement( 'div' );
        confirmEl.id = 'app-confirm';
        confirmEl.className = 'modal';
        confirmEl.style.position = 'fixed';
        confirmEl.style.left = '0';
        confirmEl.style.top = '0';
        confirmEl.style.width = '100%';
        confirmEl.style.height = '100%';
        confirmEl.style.zIndex = '10000';
        confirmEl.style.display = 'none';
        confirmEl.style.alignItems = 'center';
        confirmEl.style.justifyContent = 'center';
        confirmEl.innerHTML = `
          <div class="modal-content card">
            <p id="app-confirm-message" style="margin-top:0"></p>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
              <button id="app-confirm-cancel" class="btn"></button>
              <button id="app-confirm-ok" class="btn btn-primary"></button>
            </div>
          </div>
        `;
        document.body.appendChild( confirmEl );
      }

      const msg = document.getElementById( 'app-confirm-message' );
      const ok = document.getElementById( 'app-confirm-ok' );
      const cancel = document.getElementById( 'app-confirm-cancel' );

      // Set button text dynamically
      cancel.textContent = cancelText;
      ok.textContent = okText;

      function cleanup ( result )
      {
        confirmEl.style.display = 'none';
        ok.removeEventListener( 'click', onOk );
        cancel.removeEventListener( 'click', onCancel );
        confirmEl.removeEventListener( 'click', onOverlay );
        document.removeEventListener( 'keydown', onKeyDown );
        resolve( result );
      }

      // Handle Escape key as Cancel for confirm modal
      function onKeyDown ( ev ) { if ( ev && ( ev.key === 'Escape' || ev.key === 'Esc' ) ) { onCancel(); } }
      document.addEventListener( 'keydown', onKeyDown );

      function onOk ( ev ) { ev && ev.preventDefault(); cleanup( true ); }
      function onCancel ( ev ) { ev && ev.preventDefault(); cleanup( false ); }
      function onOverlay ( ev ) { if ( ev.target === confirmEl ) cleanup( false ); }

      ok.addEventListener( 'click', onOk );
      cancel.addEventListener( 'click', onCancel );
      confirmEl.addEventListener( 'click', onOverlay );

      msg.innerHTML = '<i class="fas fa-question-circle" style="color:#0ea5a4;margin-right:8px"></i>' + ( message || '' );
      confirmEl.style.display = 'flex';
    } );
  }

  // expose global helper
  window.showAppModal = showAppModal;
  window.showAppConfirm = showAppConfirm;
  // Global Escape handler: close informational modal (if visible)
  document.addEventListener( 'keydown', ( ev ) =>
  {
    if ( !ev ) return;
    if ( ev.key === 'Escape' || ev.key === 'Esc' )
    {
      const m = document.getElementById( 'app-modal' );
      if ( m && m.style && m.style.display === 'flex' ) m.style.display = 'none';
    }
  } );
} )();

// Image modal for zoomed selfie viewing
( function ()
{
  function showImageModal ( imageSrc, altText )
  {
    if ( !imageSrc ) return;

    // Create modal if not exists
    let modal = document.getElementById( 'image-modal' );
    if ( !modal )
    {
      modal = document.createElement( 'div' );
      modal.id = 'image-modal';
      modal.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:10000;display:none;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
      modal.innerHTML = `
        <div style="position:relative;max-width:90%;max-height:90%;">
          <button id="close-image-modal" style="position:absolute;top:-40px;right:0;background:transparent;border:none;color:white;font-size:32px;cursor:pointer;padding:5px 10px;">&times;</button>
          <img id="modal-image" style="max-width:100%;max-height:90vh;object-fit:contain;border-radius:8px;">
        </div>
      `;
      document.body.appendChild( modal );

      // Close on button click
      document.getElementById( 'close-image-modal' ).addEventListener( 'click', () =>
      {
        modal.style.display = 'none';
      } );

      // Close on overlay click
      modal.addEventListener( 'click', ( e ) =>
      {
        if ( e.target === modal )
        {
          modal.style.display = 'none';
        }
      } );

      // Close on Escape key
      document.addEventListener( 'keydown', ( e ) =>
      {
        if ( e.key === 'Escape' && modal.style.display === 'flex' )
        {
          modal.style.display = 'none';
        }
      } );
    }

    // Set image and show modal
    const img = document.getElementById( 'modal-image' );
    img.src = imageSrc;
    img.alt = altText || 'Selfie';
    modal.style.display = 'flex';
  }

  window.showImageModal = showImageModal;
} )();

// Device detection helper: set a cookie `device_type=mobile|desktop` for server-side enforcement
( function ()
{
  try
  {
    function detectMobile ()
    {
      // Best-effort mobile detection: userAgent + touch support
      const ua = navigator.userAgent || '';
      const touch = ( 'ontouchstart' in window ) || ( navigator.maxTouchPoints && navigator.maxTouchPoints > 0 );
      return /Mobi|Android|iPhone|iPad|Windows Phone/i.test( ua ) || touch;
    }

    const isMobile = detectMobile() ? 'mobile' : 'desktop';
    // set session cookie (no expiry) for server to read; path=/ so it's sent for all requests
    document.cookie = `device_type=${ encodeURIComponent( isMobile ) }; path=/`;
  } catch ( e ) { /* silent fallback */ }
} )();

// --- Global Date Picker Initialization ---
document.addEventListener( 'DOMContentLoaded', function ()
{
  // Check if the flatpickr library is loaded on this page
  if ( typeof flatpickr !== 'undefined' )
  {
    flatpickr( "input[type=date]", {
      locale: {
        firstDayOfWeek: 1 // Start week on Monday
      },
      disableMobile: true,  // Force custom picker on mobile
      dateFormat: "Y-m-d",  // Format for Database (2025-12-06)
      altInput: true,       // Enable friendly display
      altFormat: "j-M-y",   // User sees: 6-Dec-25
      allowInput: true      // Allow manual typing
    } );
  }
} );

// --- Bottom Navigation Component ---
// Auto-generates navigation based on user role and current page
function initBottomNav ( currentPage, userRole )
{
  // Define navigation items for each role
  const navItems = {
    owner: [
      { page: 'team', icon: 'fa-user-shield', href: '/team', title: 'Team Management' },
      { page: 'appsettings', icon: 'fa-cog', href: '/appsettings', title: 'Settings' },
      { page: 'visual', icon: 'fa-calendar-alt', href: '/visual', title: 'Calendar' },
      { page: 'profile', icon: 'fa-user-circle', href: '/profile', title: 'Profile' },
      { page: 'logout', icon: 'fa-sign-out-alt', href: '/logout', title: 'Logout' }
    ],
    manager: [
      { page: 'dashboard', icon: 'fa-home', href: '/dashboard', title: 'Home' },
      { page: 'team', icon: 'fa-user-shield', href: '/team', title: 'Team Management' },
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

// --- BRANDING APPLICATION ---
// Apply company branding (logo, color, name) to all pages
async function applyBranding ()
{
  try
  {
    const res = await fetch( '/branding' );
    if ( !res.ok ) return;

    const branding = await res.json();

    // Apply brand color to CSS variables
    if ( branding.brandColor )
    {
      document.documentElement.style.setProperty( '--brand-color', branding.brandColor );
      document.documentElement.style.setProperty( '--accent', branding.brandColor );
    }

    // Update page title with company name
    if ( branding.companyName && document.title )
    {
      const currentTitle = document.title;
      if ( !currentTitle.includes( branding.companyName ) )
      {
        document.title = branding.companyName + ' - ' + currentTitle;
      }
    }

    // Add logo to header if it exists (on login and dashboard pages)
    if ( branding.logo )
    {
      // Check if we're on login page or main pages
      const container = document.querySelector( '.container' );
      if ( container )
      {
        // Check if logo already exists to prevent duplicates
        let logoImg = container.querySelector( '.branding-logo' );

        // Find h1 to insert logo inline
        const h1 = container.querySelector( 'h1' );

        if ( h1 && !logoImg )
        {
          // Create inline logo for pages with h1 (dashboard, team, etc.)
          logoImg = document.createElement( 'img' );
          logoImg.className = 'branding-logo';
          logoImg.src = branding.logo;
          logoImg.alt = branding.companyName || 'Company Logo';
          logoImg.style.maxHeight = '40px';
          logoImg.style.maxWidth = '150px';
          logoImg.style.marginRight = '10px';
          logoImg.style.verticalAlign = 'middle';

          // Insert logo before the icon in h1
          h1.insertBefore( logoImg, h1.firstChild );
        }
        else if ( !h1 && !logoImg )
        {
          // For login page without h1, use centered logo
          const logoDiv = document.createElement( 'div' );
          logoDiv.className = 'branding-logo';
          logoDiv.style.textAlign = 'center';
          logoDiv.style.marginBottom = '16px';

          logoImg = document.createElement( 'img' );
          logoImg.src = branding.logo;
          logoImg.alt = branding.companyName || 'Company Logo';
          logoImg.style.maxHeight = '60px';
          logoImg.style.maxWidth = '200px';

          logoDiv.appendChild( logoImg );
          container.insertBefore( logoDiv, container.firstChild );
        }
        else if ( logoImg && logoImg.src !== branding.logo )
        {
          // Update existing logo if changed
          logoImg.src = branding.logo;
          logoImg.alt = branding.companyName;
        }
      }
    }

    // Add profile picture to header (all logged-in pages)
    try
    {
      const userRes = await fetch( '/user/me' );
      if ( userRes.ok )
      {
        const user = await userRes.json();
        const profileName = document.getElementById( 'profile-name' );
        const profileRole = document.getElementById( 'profile-role' );

        if ( profileName && user )
        {
          // Find or create avatar container (look for .nav-avatar in parent, or #header-avatar)
          let avatarImg = profileName.parentElement.querySelector( '.nav-avatar' ) || document.getElementById( 'header-avatar' );
          if ( !avatarImg )
          {
            avatarImg = document.createElement( 'img' );
            avatarImg.className = 'nav-avatar';
            avatarImg.alt = 'Profile';
            profileName.parentElement.insertBefore( avatarImg, profileName );
          }
          // Set avatar source and alt
          const profilePicUrl = user.profile_picture || '/default-avatar.svg';
          // Add cache buster for profile pictures to force refresh
          const cacheBuster = user.profile_picture ? '?t=' + new Date().getTime() : '';
          avatarImg.src = profilePicUrl + cacheBuster;
          avatarImg.alt = user.displayName || user.name || 'Profile';
          avatarImg.style.display = 'inline-block';
        }
      }
    }
    catch ( e )
    {
      // User not logged in - skip avatar (e.g., on login page)
    }
  }
  catch ( e )
  {
    // Silently fail - branding is optional
    console.log( 'Branding not available', e );
  }
}

// Call on page load - ensure DOM is ready
// Since ui.js is loaded at the end of body, DOM elements should be available
// Call immediately if interactive/complete, otherwise wait for DOMContentLoaded
if ( document.readyState === 'loading' )
{
  document.addEventListener( 'DOMContentLoaded', applyBranding );
}
else
{
  // Call immediately, and also ensure it runs after a short delay in case of race conditions
  applyBranding();
}

// Make it available globally for refresh after upload
window.applyBranding = applyBranding;