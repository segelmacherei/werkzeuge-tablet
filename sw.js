/* Service Worker der Web-App: App-Dateien und Werkzeuge aus dem Cache (offline-fähig) */
const APP='seg-app-v1',TOOLS='seg-tools-v1';
const FILES=['./','index.html','app.js','shim.js','webcap.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(APP).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==APP&&k!==TOOLS).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(u.origin!==location.origin||e.request.method!=='GET')return;
  const base=new URL('./',self.registration.scope).pathname;
  const rel=u.pathname.startsWith(base)?u.pathname.slice(base.length):'';
  if(rel.startsWith('w/')){ // Werkzeuge aus Nextcloud (von der App gespeichert)
    e.respondWith(caches.open(TOOLS).then(async c=>{const key=new URL(base+rel.split('/').map(s=>encodeURIComponent(decodeURIComponent(s))).join('/'),location.origin).href;
      return (await c.match(key))||(await c.match(e.request,{ignoreSearch:true}))||new Response('Werkzeug nicht gespeichert – App einmal mit Internet starten.',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}})}));
    return}
  // App-Dateien: zuerst Netz (aktuell), sonst Cache
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cl=r.clone();caches.open(APP).then(c=>c.put(e.request,cl))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))))});
