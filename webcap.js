/* Web-Version der Tablet-App: ersetzt die nativen Capacitor-Teile durch Browser-Funktionen.
 * Dav        -> fetch (Nextcloud mit CORS über die App „WebAppPassword“)
 * Preferences-> localStorage
 * Filesystem -> Werkzeug-Dateien (w/...) im Cache (über den Service Worker ausgeliefert), alles andere in IndexedDB
 * Share      -> navigator.share bzw. Download
 * Browser    -> neues Fenster
 */
(function(){
'use strict';
const b2u=b=>{const s=atob(b||'');const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u};
const u2b=u=>{let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)};
const BASE=new URL('./',location.href).href;
const TOOLS='seg-tools-v1';
/* ---- IndexedDB (Schlüssel -> Wert) ---- */
let dbP=null;
function db(){return dbP||(dbP=new Promise((res,rej)=>{const r=indexedDB.open('seg-app',1);r.onupgradeneeded=()=>r.result.createObjectStore('f');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))}
async function idb(mode,fn){const d=await db();return new Promise((res,rej)=>{const t=d.transaction('f',mode),st=t.objectStore('f');const q=fn(st);t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error)})}
const key=(dir,path)=>dir+':'+path;
const toolUrl=path=>BASE+path.split('/').map(encodeURIComponent).join('/');

window.Capacitor={isWeb:true,
  convertFileSrc:u=>u,
  Plugins:{
    Dav:{async request(o){
      const h=Object.assign({},o.headers||{});delete h['OCS-APIRequest'];delete h['User-Agent'];
      if(o.contentType)h['Content-Type']=o.contentType;
      const body=(o.method==='GET'||o.method==='HEAD')?undefined:(o.bodyBase64!=null?b2u(o.bodyBase64):o.body);
      let r;try{r=await fetch(o.url,{method:o.method,headers:h,body,credentials:'omit',cache:'no-store'})}catch(e){throw new Error('Netzwerk/CORS: '+(e.message||e))}
      const headers={};r.headers.forEach((v,k)=>headers[k]=v);
      const data=o.responseType==='base64'?u2b(new Uint8Array(await r.arrayBuffer())):await r.text();
      return {status:r.status,headers,data}}},
    Preferences:{
      async get({key}){let v=null;try{v=localStorage.getItem('seg:'+key)}catch(e){}return {value:v}},
      async set({key,value}){try{localStorage.setItem('seg:'+key,value)}catch(e){}},
      async remove({key}){try{localStorage.removeItem('seg:'+key)}catch(e){}},
      async keys(){const k=[];try{for(let i=0;i<localStorage.length;i++){const x=localStorage.key(i);if(x&&x.startsWith('seg:'))k.push(x.slice(4))}}catch(e){}return {keys:k}}},
    Filesystem:{
      async writeFile({path,data,directory,encoding}){
        if(directory==='DATA'&&/^w\//.test(path)){const c=await caches.open(TOOLS);const body=encoding?data:b2u(data);
          await c.put(new Request(toolUrl(path)),new Response(body,{headers:{'Content-Type':/\.html?$/i.test(path)?'text/html; charset=utf-8':'application/octet-stream'}}));return {uri:toolUrl(path)}}
        await idb('readwrite',st=>st.put({data,encoding:!!encoding},key(directory,path)));return {uri:key(directory,path)}},
      async readFile({path,directory,encoding}){
        if(directory==='DATA'&&/^w\//.test(path)){const c=await caches.open(TOOLS);const r=await c.match(toolUrl(path));if(!r)throw new Error('File does not exist');return {data:encoding?await r.text():u2b(new Uint8Array(await r.arrayBuffer()))}}
        const v=await idb('readonly',st=>st.get(key(directory,path)));if(!v)throw new Error('File does not exist');
        if(encoding&&!v.encoding)return {data:new TextDecoder().decode(b2u(v.data))};
        if(!encoding&&v.encoding)return {data:u2b(new TextEncoder().encode(v.data))};
        return {data:v.data}},
      async deleteFile({path,directory}){await idb('readwrite',st=>st.delete(key(directory,path)))},
      async getUri({path,directory}){return {uri:directory==='DATA'&&/^w\//.test(path)?toolUrl(path):key(directory,path)}}},
    Share:{async share({title,files}){
      const v=await idb('readonly',st=>st.get(files[0]));if(!v)throw new Error('Datei fehlt');
      const bytes=v.encoding?new TextEncoder().encode(v.data):b2u(v.data),name=(files[0].split('/').pop()||title||'Datei');
      const f=new File([bytes],name,{type:/\.pdf$/i.test(name)?'application/pdf':'application/octet-stream'});
      if(navigator.canShare&&navigator.canShare({files:[f]})){try{await navigator.share({files:[f],title:name});return}catch(e){if(e.name==='AbortError')return}}
      const a=document.createElement('a');a.href=URL.createObjectURL(f);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}},
    Browser:{async open({url}){window.open(url,'_blank','noopener')},async close(){}},
  }};
/* Service Worker: liefert die gespeicherten Werkzeuge aus (auch offline) */
window.__swReady=('serviceWorker' in navigator)?navigator.serviceWorker.register('sw.js').then(()=>navigator.serviceWorker.ready).then(()=>{
  if(!navigator.serviceWorker.controller){return new Promise(r=>{navigator.serviceWorker.addEventListener('controllerchange',()=>r(),{once:true});setTimeout(r,3000)})}}).catch(e=>console.warn('SW',e)):Promise.resolve();
})();
