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

    msg.textContent = message || '';
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
  function showAppConfirm ( message )
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
              <button id="app-confirm-cancel" class="btn">Cancel</button>
              <button id="app-confirm-ok" class="btn btn-primary">OK</button>
            </div>
          </div>
        `;
        document.body.appendChild( confirmEl );
      }

      const msg = document.getElementById( 'app-confirm-message' );
      const ok = document.getElementById( 'app-confirm-ok' );
      const cancel = document.getElementById( 'app-confirm-cancel' );

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

      msg.textContent = message || '';
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