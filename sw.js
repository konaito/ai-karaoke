const CACHE_NAME = 'ai-karaoke-v20';
const SHELL = ['./', './index.html', './styles.css?v=20', './app.js?v=20', './song-data.js', './catalog.json', './manifest.webmanifest', './icon.svg', './dsp.wasm'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch('./catalog.json', {cache: 'reload'});
    if (!response.ok) throw new Error('Catalog unavailable');
    const catalog = await response.json();
    const assets = [...new Set([...SHELL, ...catalog.songs.flatMap(song => [song.data, ...song.assets])])];
    await Promise.all(assets.map(asset => cache.add(new Request(asset, {cache: 'reload'}))));
    // The app offers an update button; do not interrupt a song on installation.
  })());
});
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('ai-karaoke-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const request = event.request;
    // Song selection is a query on the same shell. Works offline as well.
    const cached = request.mode === 'navigate'
      ? await cache.match('./index.html') : await cache.match(request);
    return cached || fetch(request);
  })());
});
