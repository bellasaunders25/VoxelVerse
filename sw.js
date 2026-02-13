const CACHE_NAME = 'voxelverse-v1';
const ASSETS_TO_CACHE = [
  './index.html',
  './play/index.html',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Press+Start+2P&display=swap',
  'https://i.postimg.cc/c45qLgQX/vv_logo.png',
  'https://i.postimg.cc/bNFXwDQL/vv_icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
