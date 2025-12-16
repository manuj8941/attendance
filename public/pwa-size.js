// PWA Desktop Window Size Controller
// Forces mobile-width window on desktop installations

( function ()
{
    // Check if running as installed PWA
    const isStandalone = window.matchMedia( '(display-mode: standalone)' ).matches ||
        window.navigator.standalone ||
        document.referrer.includes( 'android-app://' );

    if ( isStandalone && window.innerWidth > 450 )
    {
        // Running as PWA on desktop - set max width constraint
        document.documentElement.style.maxWidth = '420px';
        document.documentElement.style.margin = '0 auto';
        document.body.style.maxWidth = '420px';
        document.body.style.margin = '0 auto';

        // Add background to fill sides
        document.body.style.boxShadow = '0 0 0 100vw #f8fafc';
        document.body.style.clipPath = 'inset(0 -100vw)';
    }

    // Request specific window size on install (Chrome desktop PWA)
    window.addEventListener( 'beforeinstallprompt', ( e ) =>
    {
        // Store for later use
        window.deferredPrompt = e;
    } );

    // After installation, suggest window resize
    window.addEventListener( 'appinstalled', () =>
    {
        console.log( 'PWA installed - optimal width: 420px' );
    } );
} )();
