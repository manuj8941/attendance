const CACHE_NAME = 'attendance-v1';
const urlsToCache = [
    '/',
    '/login.html',
    '/dashboard.html',
    '/team.html',
    '/profile.html',
    '/visual.html',
    '/appsettings.html',
    '/css/mobile.css',
    '/js/ui.js',
    '/airbnb.css',
    '/flatpickr.min.css',
    '/flatpickr.min.js',
    '/default-avatar.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

// Install event - cache critical resources
self.addEventListener( 'install', ( event ) =>
{
    event.waitUntil(
        caches.open( CACHE_NAME )
            .then( ( cache ) =>
            {
                console.log( 'Service Worker: Caching files' );
                return cache.addAll( urlsToCache ).catch( ( err ) =>
                {
                    console.log( 'Service Worker: Cache addAll error:', err );
                } );
            } )
            .then( () => self.skipWaiting() )
    );
} );

// Activate event - clean up old caches
self.addEventListener( 'activate', ( event ) =>
{
    event.waitUntil(
        caches.keys().then( ( cacheNames ) =>
        {
            return Promise.all(
                cacheNames.map( ( cacheName ) =>
                {
                    if ( cacheName !== CACHE_NAME )
                    {
                        console.log( 'Service Worker: Deleting old cache:', cacheName );
                        return caches.delete( cacheName );
                    }
                } )
            );
        } ).then( () => self.clients.claim() )
    );
} );

// Fetch event - network first, fallback to cache
self.addEventListener( 'fetch', ( event ) =>
{
    // Skip non-GET requests
    if ( event.request.method !== 'GET' ) return;

    // Skip chrome-extension and other non-http(s) requests
    if ( !event.request.url.startsWith( 'http' ) ) return;

    event.respondWith(
        fetch( event.request )
            .then( ( response ) =>
            {
                // Clone the response before caching
                const responseToCache = response.clone();

                // Cache successful responses
                if ( response.status === 200 )
                {
                    caches.open( CACHE_NAME ).then( ( cache ) =>
                    {
                        cache.put( event.request, responseToCache );
                    } );
                }

                return response;
            } )
            .catch( () =>
            {
                // Network failed, try cache
                return caches.match( event.request ).then( ( cachedResponse ) =>
                {
                    if ( cachedResponse )
                    {
                        return cachedResponse;
                    }

                    // Return offline page for navigation requests
                    if ( event.request.mode === 'navigate' )
                    {
                        return caches.match( '/login.html' );
                    }
                } );
            } )
    );
} );
