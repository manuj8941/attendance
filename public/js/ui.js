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

  // expose global helper
  window.showAppModal = showAppModal;
} )();
