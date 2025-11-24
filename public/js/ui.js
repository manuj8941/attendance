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
        <div style="display:flex;justify-content:flex-end"><button id="app-modal-close" class="close-button" style="border:none;background:transparent;font-size:20px">&times;</button></div>
        <p id="app-modal-message" style="margin-top:0"></p>
        <div style="margin-top:12px"><button id="app-modal-ok" class="btn">OK</button></div>
      </div>
    `;
    document.body.appendChild( modal );

    const close = modal.querySelector( '#app-modal-close' );
    const ok = modal.querySelector( '#app-modal-ok' );
    const hide = () => { modal.style.display = 'none'; };
    close.addEventListener( 'click', hide );
    ok.addEventListener( 'click', hide );
    modal.addEventListener( 'click', ( ev ) => { if ( ev.target === modal ) hide(); } );
  }

  function showAppModal ( message, type )
  {
    ensureModal();
    const modal = document.getElementById( 'app-modal' );
    const msg = document.getElementById( 'app-modal-message' );
    msg.textContent = message || '';
    msg.className = type === 'success' ? 'status-approved' : ( type === 'error' ? 'status-rejected' : '' );
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
        resolve( result );
      }

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
