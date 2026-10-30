/* Segelmacherei Werkzeuge – Tablet-App (Startseite)
 * - Anmeldung an Nextcloud (Login Flow v2, App-Passwort)
 * - lädt die Werkzeuge (Werkzeuge.html + Offerte und Montage/*.html) aus Nextcloud und speichert sie auf dem Tablet
 * - stellt den Werkzeugen über window.__seg einen Dateizugriff auf Nextcloud (WebDAV) bereit, mit Offline-Zwischenspeicher
 */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const C=window.Capacitor||{};
const plug=(name,method,opts)=>{const p=C.Plugins&&C.Plugins[name];if(p&&typeof p[method]==='function')return p[method](opts||{});
  if(typeof C.nativePromise==='function')return C.nativePromise(name,method,opts||{});return Promise.reject(new Error('Plugin '+name+' fehlt'))};
const FS={DATA:'DATA',CACHE:'CACHE'};
const TOOL_HOST='Werkzeuge.html';

/* ---------------- Einstellungen ---------------- */
let cfg=null; // {server,user,pass,root}
async function prefGet(k){try{const r=await plug('Preferences','get',{key:k});return r&&r.value!=null?JSON.parse(r.value):null}catch(e){return null}}
async function prefSet(k,v){try{await plug('Preferences','set',{key:k,value:JSON.stringify(v)})}catch(e){}}
/* Zugangsdaten (App-Passwort, Anmeldungen der Werkzeuge) im verschlüsselten Tresor der App (Android-Keystore); ältere Klartext-Einträge werden beim ersten Lesen dorthin verschoben. Ohne Tresor (Browser, alte App): wie bisher. */
let tresorOk=null;
async function tresorBereit(){if(C.isWeb)return false;if(tresorOk!=null)return tresorOk;try{const r=await plug('Tresor','info');tresorOk=!!(r&&r.ok)}catch(e){tresorOk=false}return tresorOk}
async function sGet(k){if(await tresorBereit()){try{const r=await plug('Tresor','get',{key:k});if(r&&r.value!=null)return JSON.parse(r.value)}catch(e){}
    const alt=await prefGet(k);if(alt!=null){try{await plug('Tresor','set',{key:k,value:JSON.stringify(alt)});const t=await plug('Tresor','get',{key:k});if(t&&t.value!=null)await plug('Preferences','remove',{key:k})}catch(e){}}return alt}
  return prefGet(k)}
async function sSet(k,v){if(await tresorBereit()){try{if(v==null)await plug('Tresor','remove',{key:k});else await plug('Tresor','set',{key:k,value:JSON.stringify(v)});try{await plug('Preferences','remove',{key:k})}catch(e){}return}catch(e){}}await prefSet(k,v)}

/* ---------------- Hilfen ---------------- */
const b64utf8=s=>btoa(unescape(encodeURIComponent(s)));
function bytesToB64(u8){let s='';const n=0x8000;for(let i=0;i<u8.length;i+=n)s+=String.fromCharCode.apply(null,u8.subarray(i,i+n));return btoa(s)}
function b64ToBytes(b){const s=atob(b||'');const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u}
/* Pfade immer innerhalb des eigenen Nextcloud-Kontos: „.“ fällt weg, „..“ ist verboten (sonst Ausbruch aus /remote.php/dav/files/<benutzer>) */
const norm=p=>{const t=String(p||'').split('/').filter(s=>s&&s!=='.');if(t.includes('..'))throw Object.assign(new Error('Ungültiger Pfad (enthält „..“): '+p),{name:'SecurityError'});return '/'+t.join('/')};
const parentOf=p=>{const a=norm(p).split('/');a.pop();return a.join('/')||'/'};
const nameOf=p=>norm(p).split('/').pop();
const encPath=p=>norm(p).split('/').map(encodeURIComponent).join('/');
const safeKey=p=>norm(p).replace(/[^A-Za-z0-9._\-\/ äöüÄÖÜéèàç]/g,'_');
class NetErr extends Error{constructor(m){super(m);this.name='NetworkError';this.offline=true}}
class AuthErr extends Error{constructor(m){super(m||'Anmeldung abgelaufen');this.name='AuthError'}}

let online=true;
function setOnline(v,why){if(online===v)return;online=v;showNet(v?'Wieder online'+(why?' – '+why:''):'Offline – Änderungen werden auf dem Tablet gespeichert und später hochgeladen',v?2500:0);if(v)flushOutbox()}
let netT=0;function showNet(t,ms){const n=$('net');if(!t){n.style.display='none';return}n.textContent=t;n.style.display='block';clearTimeout(netT);if(ms)netT=setTimeout(()=>{n.style.display='none'},ms)}

/* ---------------- WebDAV ---------------- */
const davBase=()=>cfg.server.replace(/\/+$/,'')+'/remote.php/dav/files/'+encodeURIComponent(cfg.user);
async function davRaw(method,path,o={}){
  const headers=Object.assign({Authorization:'Basic '+b64utf8(cfg.user+':'+cfg.pass),'OCS-APIRequest':'true'},o.headers||{});
  let r;try{r=await plug('Dav','request',{method,url:davBase()+encPath(path)+(o.slash?'/':''),headers,body:o.body,bodyBase64:o.bodyBase64,contentType:o.contentType,responseType:o.responseType||'text'})}
  catch(e){setOnline(false);throw new NetErr('Keine Verbindung zu Nextcloud')}
  if(!online)setOnline(true);
  if(r.status===401){if($('app').style.display==='block')showNet('Nextcloud lehnt die Anmeldung ab (App-Passwort gesperrt?) – bitte abmelden und neu anmelden.',8000);throw new AuthErr()}
  return r}
const etagAus=h=>{h=h||{};const v=h['oc-etag']||h['etag']||'';return v?String(v).replace(/^W\//,'').replace(/"/g,''):null};
const PROPS='<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/><d:getetag/></d:prop></d:propfind>';
function parseMS(xml){const doc=new DOMParser().parseFromString(xml,'application/xml'),NS='DAV:',out=[];
  const basePath=decodeURIComponent(new URL(davBase()).pathname).replace(/\/+$/,'');
  for(const r of doc.getElementsByTagNameNS(NS,'response')){const href=r.getElementsByTagNameNS(NS,'href')[0];if(!href)continue;
    let p=decodeURIComponent(href.textContent.replace(/^https?:\/\/[^/]+/,''));if(p.startsWith(basePath))p=p.slice(basePath.length);p=norm(p);
    let ok=false;const pr={};for(const ps of r.getElementsByTagNameNS(NS,'propstat')){const st=(ps.getElementsByTagNameNS(NS,'status')[0]||{}).textContent||'';if(!/ 200 /.test(st))continue;ok=true;const prop=ps.getElementsByTagNameNS(NS,'prop')[0];
      pr.dir=!!prop.getElementsByTagNameNS(NS,'collection')[0];const g=t=>{const e=prop.getElementsByTagNameNS(NS,t)[0];return e?e.textContent:''};
      pr.size=+g('getcontentlength')||0;pr.mtime=Date.parse(g('getlastmodified'))||0;pr.etag=g('getetag').replace(/"/g,'')}
    if(ok)out.push({path:p,name:nameOf(p),...pr})}
  return out}
async function davList(path){const r=await davRaw('PROPFIND',path,{slash:true,body:PROPS,contentType:'application/xml; charset=utf-8',headers:{Depth:'1'}});
  if(r.status===404)return null;if(r.status!==207)throw new Error('Ordner konnte nicht gelesen werden ('+r.status+')');
  const all=parseMS(r.data),me=norm(path);return {self:all.find(e=>e.path===me)||{path:me,name:nameOf(me),dir:true},items:all.filter(e=>e.path!==me)}}
async function davStat(path){const r=await davRaw('PROPFIND',path,{body:PROPS,contentType:'application/xml; charset=utf-8',headers:{Depth:'0'}});
  if(r.status===404)return null;if(r.status!==207)throw new Error('Fehler '+r.status);return parseMS(r.data)[0]||null}
async function davMkcolDeep(path){const parts=norm(path).split('/').filter(Boolean);let cur='';for(const s of parts){cur+='/'+s;const r=await davRaw('MKCOL',cur);if(r.status!==201&&r.status!==405&&r.status!==301)throw new Error('Ordner '+cur+' konnte nicht erstellt werden ('+r.status+')')}}

/* ---------------- Offline-Zwischenspeicher ---------------- */
// Dateien: DATA/oc/<pfad>  (base64), Ordnerlisten: DATA/ol/<pfad>/.list.json, Ausgang: Preferences 'outbox'
const mem=new Map(); // pfad -> {t, list}
async function fsW(path,data,enc){await plug('Filesystem','writeFile',{path,data,directory:FS.DATA,recursive:true,...(enc?{encoding:enc}:{})})}
async function fsR(path,enc){const r=await plug('Filesystem','readFile',{path,directory:FS.DATA,...(enc?{encoding:enc}:{})});return r.data}
async function fsDel(path){try{await plug('Filesystem','deleteFile',{path,directory:FS.DATA})}catch(e){}}
const cacheFile=p=>'oc'+safeKey(p);
const cacheList=p=>'ol'+safeKey(p)+'/.list.json';
let outbox=[];let outboxLoaded=false;
async function loadOutbox(){if(outboxLoaded)return;outbox=(await prefGet('outbox'))||[];outboxLoaded=true}
async function saveOutbox(){await prefSet('outbox',outbox)}
function obFind(p){p=norm(p);return outbox.find(o=>o.path===p)}

async function list(path,fresh){path=norm(path);await loadOutbox();
  const m=mem.get(path);if(!fresh&&m&&Date.now()-m.t<4000)return merge(path,m.list);
  try{const L=await davList(path);if(!L){mem.delete(path);return null}
    mem.set(path,{t:Date.now(),list:L.items});fsW(cacheList(path),JSON.stringify(L.items),'utf8').catch(()=>{});return merge(path,L.items)}
  catch(e){if(!(e instanceof NetErr))throw e;
    if(m)return merge(path,m.list);
    try{const it=JSON.parse(await fsR(cacheList(path),'utf8'));return merge(path,it)}catch(_){ }
    if(outbox.some(o=>parentOf(o.path)===path||o.path.startsWith(path+'/')))return merge(path,[]);
    throw e}}
function merge(path,items){const it=items.slice();
  for(const o of outbox){if(o.del)continue;const par=parentOf(o.path);
    if(par===path){if(!it.some(e=>e.path===o.path))it.push({path:o.path,name:nameOf(o.path),dir:false,size:o.size||0,mtime:o.t,etag:'local'})}
    else if(o.path.startsWith(path+'/')){const sub=path+'/'+o.path.slice(path.length+1).split('/')[0];if(!it.some(e=>e.path===sub))it.push({path:sub,name:nameOf(sub),dir:true,size:0,mtime:o.t})}}
  return it.filter(e=>!outbox.some(o=>o.del&&o.path===e.path))}
async function stat(path){path=norm(path);if(path==='/')return {path:'/',name:'',dir:true};const L=await list(parentOf(path));if(!L)return null;return L.find(e=>e.path===path)||null}

/* Zuletzt bekannte Version (ETag) jeder gelesenen/geschriebenen Datei. Damit überschreibt eine offline gespeicherte Datei beim
   späteren Hochladen keine Änderung, die inzwischen ein anderes Gerät gemacht hat (dann → Konfliktkopie, die Hülle führt sie zusammen). */
let etags=null,etagT=0;
async function etagMap(){if(!etags)etags=(await prefGet('etags'))||{};return etags}
function etagMerk(path,tag){if(!etags)return;delete etags[path];if(tag)etags[path]=tag;
  const k=Object.keys(etags);if(k.length>800)for(const x of k.slice(0,k.length-800))delete etags[x];
  clearTimeout(etagT);etagT=setTimeout(()=>prefSet('etags',etags),1500)}
const zwei=n=>String(n).padStart(2,'0');
function konfliktPfad(p){const d=new Date(),st=d.getFullYear()+'-'+zwei(d.getMonth()+1)+'-'+zwei(d.getDate())+' '+zwei(d.getHours())+zwei(d.getMinutes())+zwei(d.getSeconds());
  const n=nameOf(p),i=n.lastIndexOf('.'),b=i>0?n.slice(0,i):n,x=i>0?n.slice(i):'';return parentOf(p).replace(/\/$/,'')+'/'+b+' (conflicted copy '+st+' Tablet)'+x}

async function read(path){path=norm(path);await loadOutbox();await etagMap();const ob=obFind(path);
  if(ob&&ob.del)throw Object.assign(new Error('Datei nicht gefunden: '+path),{name:'NotFoundError'});
  if(ob){const b=await fsR(ob.file);return {bytes:b64ToBytes(b),mtime:ob.t}}
  try{const r=await davRaw('GET',path,{responseType:'base64'});if(r.status===404)throw Object.assign(new Error('Datei nicht gefunden: '+path),{name:'NotFoundError'});
    if(r.status>=300)throw new Error('Lesefehler '+r.status);
    const lm=Date.parse((r.headers||{})['last-modified'])||Date.now();etagMerk(path,etagAus(r.headers));
    if((r.data||'').length<15e6)fsW(cacheFile(path),r.data).catch(()=>{});
    return {bytes:b64ToBytes(r.data),mtime:lm}}
  catch(e){if(!(e instanceof NetErr))throw e;try{const b=await fsR(cacheFile(path));return {bytes:b64ToBytes(b),mtime:0}}catch(_){throw new NetErr('Offline – diese Datei ist auf dem Tablet nicht gespeichert: '+nameOf(path))}}}

const schreibt=new Set(); // Pfade, die gerade online gespeichert werden (das Hochladen des Ausgangs überspringt sie)
async function write(path,bytes){path=norm(path);await loadOutbox();await etagMap();const b64=bytesToB64(bytes);
  if(flushP)await flushP.catch(()=>{}); // nie gleichzeitig mit dem Hochladen einer älteren Offline-Fassung derselben Datei
  const put=()=>davRaw('PUT',path,{bodyBase64:b64,contentType:'application/octet-stream'});
  schreibt.add(path);
  try{let r=await put();if(r.status===409||r.status===404){await davMkcolDeep(parentOf(path));r=await put()}
    if(r.status>=300)throw new Error('Speichern fehlgeschlagen ('+r.status+')');
    mem.delete(parentOf(path));fsW(cacheFile(path),b64).catch(()=>{});etagMerk(path,etagAus(r.headers));
    const i=outbox.findIndex(o=>o.path===path);if(i>=0){fsDel(outbox[i].file);outbox.splice(i,1);saveOutbox()}
    return {offline:false}}
  catch(e){if(!(e instanceof NetErr))throw e;
    const file='ob/'+Date.now()+'-'+Math.random().toString(36).slice(2,8);await fsW(file,b64);
    const i=outbox.findIndex(o=>o.path===path);let base=etags[path];
    if(i>=0){if(outbox[i].file)fsDel(outbox[i].file);if(outbox[i].base)base=outbox[i].base;outbox.splice(i,1)}
    outbox.push({path,file,t:Date.now(),size:bytes.length,...(base?{base}:{})});await saveOutbox();fsW(cacheFile(path),b64).catch(()=>{});
    showNet('Offline gespeichert: '+nameOf(path)+' – wird hochgeladen, sobald Netz da ist',5000);return {offline:true}}
  finally{schreibt.delete(path)}}

async function mkdir(path){path=norm(path);try{const r=await davRaw('MKCOL',path);if(r.status===409){await davMkcolDeep(path)}else if(r.status!==201&&r.status!==405)throw new Error('Ordner konnte nicht erstellt werden ('+r.status+')');mem.delete(parentOf(path))}
  catch(e){if(!(e instanceof NetErr))throw e;/* offline: Ordner entsteht beim Hochladen */}}
async function remove(path){path=norm(path);try{const r=await davRaw('DELETE',path);if(r.status>=300&&r.status!==404)throw new Error('Löschen fehlgeschlagen ('+r.status+')');mem.delete(parentOf(path))}
  catch(e){if(!(e instanceof NetErr))throw e;await loadOutbox();
    outbox=outbox.filter(o=>{const weg=o.path===path||o.path.startsWith(path+'/');if(weg&&o.file)fsDel(o.file);return !weg});outbox.push({path,del:true,t:Date.now()});await saveOutbox()}}

let flushP=null;
function flushOutbox(){if(flushP)return flushP;flushP=flushIntern().finally(()=>{flushP=null});return flushP}
async function flushIntern(){await loadOutbox();if(!outbox.length||!cfg)return;await etagMap();let n=0;const konf=[],fehl=[];
  try{for(const o of outbox.slice()){
      if(!outbox.includes(o)||schreibt.has(o.path))continue;
      if(o.del){const r=await davRaw('DELETE',o.path);if(r.status<300||r.status===404){outbox=outbox.filter(x=>x!==o);n++}continue}
      let ziel=o.path;
      if(o.base){const st=await davStat(o.path).catch(e=>{if(e instanceof NetErr||e instanceof AuthErr)throw e;return null});
        if(st&&st.etag&&st.etag!==o.base)ziel=konfliktPfad(o.path)} // inzwischen auf einem anderen Gerät geändert
      const b64=await fsR(o.file);let r=await davRaw('PUT',ziel,{bodyBase64:b64,contentType:'application/octet-stream'});
      if(r.status===409||r.status===404){await davMkcolDeep(parentOf(ziel));r=await davRaw('PUT',ziel,{bodyBase64:b64,contentType:'application/octet-stream'})}
      if(r.status<300){fsDel(o.file);outbox=outbox.filter(x=>x!==o);mem.delete(parentOf(o.path));n++;
        if(ziel!==o.path){konf.push(nameOf(o.path));etagMerk(o.path,null);fsDel(cacheFile(o.path))}else etagMerk(o.path,etagAus(r.headers))}
      else fehl.push(nameOf(o.path)+' ('+r.status+')')}
  }catch(e){}finally{await saveOutbox();
    if(konf.length){const auto=konf.every(x=>/^(Einsatzplan|Projektdaten|Lager|Servicerapporte)\.json$/i.test(x));
      showNet(konf.join(', ')+' wurde inzwischen auf einem anderen Gerät geändert. Die Tablet-Fassung wurde daneben als „(conflicted copy … Tablet)“ hochgeladen'+(auto?' und wird von den Werkzeugen automatisch zusammengeführt.':' – bitte prüfen, welche Fassung gilt.'),15000)}
    else if(fehl.length)showNet('Hochladen nicht möglich: '+fehl.join(', ')+' – bleibt auf dem Tablet gespeichert und wird später nochmals versucht.',8000);
    else if(n)showNet(n===1?'1 Datei hochgeladen':n+' Dateien hochgeladen',3000)}}
setInterval(()=>{if(cfg)flushOutbox()},60000);
window.addEventListener('online',()=>flushOutbox());

/* ---------------- Teilen / Öffnen ---------------- */
async function share(blob,name){const b=new Uint8Array(await blob.arrayBuffer());const path='export/'+name.replace(/[\\/:*?"<>|]/g,'_');
  await plug('Filesystem','writeFile',{path,data:bytesToB64(b),directory:FS.CACHE,recursive:true});
  const u=await plug('Filesystem','getUri',{path,directory:FS.CACHE});
  try{await plug('Share','share',{title:name,files:[u.uri],dialogTitle:name})}catch(e){if(!/cancel/i.test(String(e&&e.message)))showNet('Teilen nicht möglich: '+(e.message||e),4000)}}
/* Navigation im Auto: Google Maps startet direkt die Routenführung; ohne Google-Maps-App die Webseite */
async function nav(ziel){const z=String(ziel||'').trim();if(!z)return;const web='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(z)+'&travelmode=driving';
  if(C.isWeb){window.open(web,'_blank');return}
  try{await plug('Update','oeffnen',{url:'google.navigation:q='+encodeURIComponent(z)+'&mode=d'})}catch(e){openUrl(web)}}
async function openUrl(url){url=String(url||'');if(!/^(https?|mailto|tel):/i.test(url))throw new Error('Adresse nicht erlaubt: '+url.slice(0,40)); /* kein javascript:, intent:, file: … */
  try{await plug('Browser','open',{url})}catch(e){window.open(url,'_blank','noopener')}}

/* ---------------- Ordner-/Speichern-Dialog ---------------- */
function picker({mode='dir',start,suggestedName='',title}={}){return new Promise((res,rej)=>{
  let cur=norm(start||cfg.root);const D=$('dlg'),L=$('dlgList'),N=$('dlgName');
  $('dlgT').textContent=title||(mode==='save'?'Speichern unter':'Ordner wählen');N.hidden=mode!=='save';N.value=suggestedName;
  $('dlgOk').textContent=mode==='save'?'Speichern':'Diesen Ordner wählen';
  const close=()=>{D.style.display='none';$('dlgOk').onclick=$('dlgCancel').onclick=$('dlgUp').onclick=$('dlgNew').onclick=null};
  async function show(){$('dlgPath').textContent=cur;L.innerHTML='<div class="f">Lade …</div>';
    try{const it=(await list(cur)||[]).sort((a,b)=>(b.dir-a.dir)||a.name.localeCompare(b.name,'de'));L.innerHTML='';
      if(!it.length)L.innerHTML='<div class="f">(leer)</div>';
      it.forEach(e=>{const d=document.createElement('div');d.textContent=(e.dir?'📁 ':'📄 ')+e.name;if(!e.dir)d.className='f';d.onclick=()=>{if(e.dir){cur=e.path;show()}else if(mode==='save')N.value=e.name};L.append(d)})}
    catch(e){L.innerHTML='';const d=document.createElement('div');d.className='f';d.textContent='Fehler: '+(e.message||e);L.append(d)}}
  $('dlgUp').onclick=()=>{if(cur!=='/'){cur=parentOf(cur);show()}};
  $('dlgNew').onclick=async()=>{const n=(prompt('Name des neuen Ordners')||'').trim();if(!n)return;
    if(/[\\/:*?"<>|]/.test(n)||/^\.+$/.test(n)){alert('Dieser Name geht nicht. Bitte ohne \\ / : * ? " < > | und nicht nur Punkte.');return}
    try{await mkdir(cur+'/'+n);cur=norm(cur+'/'+n);show()}catch(e){alert('Ordner konnte nicht erstellt werden: '+(e.message||e))}};
  $('dlgCancel').onclick=()=>{close();const e=new Error('Abgebrochen');e.name='AbortError';rej(e)};
  $('dlgOk').onclick=()=>{if(mode==='save'){const n=N.value.trim();if(!n){N.focus();return}
      if(/[\\/:*?"<>|]/.test(n)||/^\.+$/.test(n)){alert('Dieser Dateiname geht nicht. Bitte ohne \\ / : * ? " < > |.');N.focus();return}close();res(norm(cur+'/'+n))}else{close();res(cur)}};
  D.style.display='flex';show()})}

/* ---------------- QR-Code vom Auftrag: Projekt öffnen ----------------
   Inhalt: https://app.segelmacherei.ch/#p= (früher https://segelmacherei.github.io/werkzeuge-tablet/#p=)<Exxas-Nr>  (ohne Nr.: #o=<Ordner>) oder nur die Nummer */
function linkParams(u){try{const s=String(u||'').trim();if(/^\d{4,}$/.test(s))return new URLSearchParams({nr:s});
  const url=new URL(s,location.href),h=new URLSearchParams(url.hash.replace(/^#/,'')),q=url.searchParams;
  const p=h.get('p')||q.get('p'),o=h.get('o')||q.get('o');if(p&&/^\d{4,}$/.test(p))return new URLSearchParams({nr:p});if(o)return new URLSearchParams({id:o})}catch(e){}return null}
/* Zendesk-Anmeldung: Rücksprung aus dem Browser in die App (segelmacherei://zendesk?code=…&state=… oder …/werkzeuge-tablet/zendesk.html?code=…) */
let zdHoerer=null,zdWartend=null; // nur die zuletzt geladenen Werkzeuge hören zu
function zdLink(u){try{const url=new URL(String(u||''));const z=url.protocol==='segelmacherei:'?/zendesk/.test(url.host+url.pathname):((url.host==='segelmacherei.github.io'||url.host==='app.segelmacherei.ch')&&/\/zendesk\.html$/.test(url.pathname));
  if(!z)return false;const q=url.searchParams,d={code:q.get('code'),state:q.get('state')||'',error:q.get('error'),error_description:q.get('error_description')};
  if(!d.code&&!d.error)return false;plug('Browser','close',{}).catch(()=>{});if(zdHoerer){try{zdHoerer(d)}catch(e){zdWartend=d}}else zdWartend=d;return true}catch(e){return false}}
function appLink(u){if(zdLink(u))return;openProjekt(linkParams(u))}
/* Natives HTTP nur für Zendesk und den Zendesk-Worker (die App-Seite https://localhost wird dort per CORS abgewiesen) */
async function http(url,o={}){const U=new URL(url),h=U.host;if(U.protocol!=='https:'||!(h==='segelmacherei.zendesk.com'||h==='segelmacherei-zendesk.yannicklona.workers.dev'))throw new Error('Adresse nicht erlaubt');
  return plug('Dav','request',{method:o.method||'GET',url,headers:o.headers||{},body:o.body==null?undefined:String(o.body),contentType:(o.headers&&o.headers['Content-Type'])||'application/json',responseType:'text'})}
let pendingLink=linkParams(location.href);
if(pendingLink&&C.isWeb)try{history.replaceState(null,'',location.pathname)}catch(e){}
/* Web: neuer QR-Link im selben, schon offenen Tab (nur die Adresse nach # ändert sich) */
if(C.isWeb)window.addEventListener('hashchange',()=>{const P=linkParams(location.href);if(!P)return;try{history.replaceState(null,'',location.pathname)}catch(e){}
  if(cfg&&cfg.pass)openProjekt(P);else if($('start').style.display==='none'||!$('login').hidden){const k=$('kundeSeite');if(k)k.remove();showKunde(P)}});
function openProjekt(P){if(!P)return;const f=$('app');if(!f.src||f.style.display==='none'){pendingLink=P;return}
  try{const w=f.contentWindow;if(w&&typeof w.kdDirekt==='function'){w.kdDirekt(P);return}}catch(e){}
  f.src=f.src.split('#')[0]+'#kunde?'+P.toString()}
/* QR-Code scannen: in der App mit dem Google-Scanner (ML Kit), im Browser mit BarcodeDetector + Kamera */
async function scan(){
  if(!C.isWeb){const B='BarcodeScanner';
    try{const a=await plug(B,'isGoogleBarcodeScannerModuleAvailable');if(a&&a.available===false){await plug(B,'installGoogleBarcodeScannerModule').catch(()=>{});
      showNet('Der Scanner wird einmalig installiert – in einer Minute nochmals tippen.',7000);return null}}catch(e){}
    try{const r=await plug(B,'scan',{formats:['QR_CODE']});const b=r&&r.barcodes&&r.barcodes[0];return b?(b.rawValue||b.displayValue||''):null}
    catch(e){if(/cancel/i.test(e&&e.message||''))return null;throw new Error('Scanner: '+(e&&e.message||e))}}
  if(!('BarcodeDetector' in window)||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('Scannen geht in diesem Browser nicht. Den QR-Code einfach mit der Handy-Kamera scannen.');
  const det=new BarcodeDetector({formats:['qr_code']});
  const st=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  return new Promise(res=>{const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:16px system-ui,sans-serif;color:#fff';
    ov.innerHTML='<video playsinline muted autoplay style="max-width:100%;max-height:75vh;border-radius:8px"></video><div>QR-Code vom Auftrag ins Bild halten</div><button type="button" style="font-size:17px;padding:10px 26px;border-radius:8px;border:0">Abbrechen</button>';
    document.body.append(ov);const v=ov.querySelector('video');v.srcObject=st;let fertig=false,t=0;
    const ende=x=>{if(fertig)return;fertig=true;clearTimeout(t);st.getTracks().forEach(k=>k.stop());ov.remove();res(x)};
    ov.querySelector('button').onclick=()=>ende(null);
    const lauf=async()=>{if(fertig)return;try{if(v.readyState>=2){const r=await det.detect(v);if(r&&r[0]&&r[0].rawValue)return ende(r[0].rawValue)}}catch(e){}t=setTimeout(lauf,200)};lauf()})}

/* ---------------- Werkzeuge laden ---------------- */
const SHIM='<script src="'+(C.isWeb?new URL('shim.js',location.href).href:'/shim.js')+'"></script>';
function inject(html){if(/<head[^>]*>/i.test(html))return html.replace(/<head([^>]*)>/i,m=>m+SHIM);return SHIM+html}
function msg(t,bad){const m=$('msg');m.textContent=t||'';m.className=bad?'bad':''}
function bar(f){const b=$('bar');if(f==null){b.style.display='none';return}b.style.display='block';b.firstElementChild.style.width=Math.round(f*100)+'%'}

async function syncTools(){
  const W=cfg.root+'/04 Werkzeuge',OM=W+'/Offerte und Montage';
  const man=(await prefGet('toolsManifest'))||{};
  const [a,b]=await Promise.all([davList(W),davList(OM)]);
  if(!a)throw new Error('Ordner „'+W+'“ nicht gefunden. Unter „Erweitert“ den Ordner 04-Vertrieb prüfen.');
  const want=[];a.items.filter(e=>!e.dir&&e.name===TOOL_HOST).forEach(e=>want.push({e,rel:e.name}));
  if(b)b.items.filter(e=>!e.dir&&/\.html?$/i.test(e.name)).forEach(e=>want.push({e,rel:'Offerte und Montage/'+e.name}));
  if(!want.some(w=>w.rel===TOOL_HOST))throw new Error(TOOL_HOST+' fehlt im Ordner 04 Werkzeuge.');
  /* Offline-Paket: Bibliotheken in «Offerte und Montage/lib» (PDF-Leser/-Erzeuger, Karte, STEP-Leser) mit auf das Tablet nehmen */
  if(!C.isWeb){const libs=async(d,rel,tiefe)=>{const L=await davList(d).catch(()=>null);if(!L)return;for(const e of L.items){if(e.dir){if(tiefe<3)await libs(e.path,rel+e.name+'/',tiefe+1)}else want.push({e,rel:rel+e.name,bin:true})}};
    await libs(OM+'/lib','Offerte und Montage/lib/',0)}
  const todo=want.filter(w=>man[w.rel]!==w.e.etag);let i=0;
  for(const w of todo){msg('Lade '+w.rel.split('/').pop()+' …');bar(i/todo.length);
    if(w.bin){const r=await davRaw('GET',w.e.path,{responseType:'base64'});if(r.status!==200){i++;continue} /* Bibliothek fehlt: Werkzeug lädt sie dann aus dem Internet */
      await fsW('w/'+w.rel,r.data);man[w.rel]=w.e.etag;i++;continue}
    const r=await davRaw('GET',w.e.path,{responseType:'text'});if(r.status!==200)throw new Error(w.rel+': Fehler '+r.status);
    await fsW('w/'+w.rel,inject(r.data),'utf8');man[w.rel]=w.e.etag;i++}
  bar(null);await prefSet('toolsManifest',man);await prefSet('toolsTime',Date.now());return todo.length}

async function openTools(){if(window.__swReady)await window.__swReady;const u=await plug('Filesystem','getUri',{path:'w/'+TOOL_HOST,directory:FS.DATA});
  const src=typeof C.convertFileSrc==='function'?C.convertFileSrc(u.uri):u.uri;
  const f=$('app');f.src=src+(pendingLink?'#kunde?'+pendingLink.toString():'');pendingLink=null;f.style.display='block';$('start').style.display='none'}

/* ---------------- App-Update aus der Nextcloud ----------------
   Im Ordner 04 Werkzeuge/Tablet-App liegt Segelmacherei-Werkzeuge-1.0.N.apk (Version im Namen).
   Ist die Nummer grösser als die eigene, erscheint oben ein Hinweis. Android fragt beim Installieren selbst nach. */
let updT=0;
async function updatePruefen(){if(C.isWeb||!cfg||Date.now()-updT<3600e3)return;updT=Date.now();
  try{const me=await plug('Update','info');const D=cfg.root+'/04 Werkzeuge/Tablet-App';
    /* Neuste Datei Segelmacherei-Werkzeuge-1.0.N.apk im Ordner; ältere Ablage: version.txt + Segelmacherei-Werkzeuge.apk */
    let neu='',pfad='',nr=0;const L=await davList(D).catch(()=>null);
    for(const e of (L&&L.items)||[]){const m=!e.dir&&/^Segelmacherei-Werkzeuge-(\d+)\.(\d+)\.(\d+)\.apk$/i.exec(e.name);if(m&&+m[3]>nr){nr=+m[3];neu=m[1]+'.'+m[2]+'.'+m[3];pfad=e.path}}
    if(!nr){const r=await davRaw('GET',D+'/version.txt',{responseType:'text'});if(r.status!==200)return;neu=String(r.data||'').trim();nr=+(neu.split('.').pop()||0);pfad=D+'/Segelmacherei-Werkzeuge.apk'}
    if(!nr||nr<=+me.versionCode)return;
    updateHinweis(neu,me,pfad)}catch(e){console.warn('Update-Prüfung',e)}}
function updateHinweis(neu,me,pfad){let u=$('updBar');if(u)u.remove();u=document.createElement('div');u.id='updBar';
  u.style.cssText='position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#1d2330;color:#fff;border-radius:12px;padding:10px 12px 10px 16px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:15px system-ui,sans-serif;display:flex;gap:10px;align-items:center;max-width:calc(100% - 24px)';
  u.innerHTML='<span id="updT">Neue App-Version '+neu+' (jetzt '+me.versionName+')</span><button id="updGo" style="font:inherit;padding:8px 14px;border:0;border-radius:8px;background:#1f6feb;color:#fff">Aktualisieren</button><button id="updX" style="font:inherit;padding:8px 10px;border:0;border-radius:8px;background:#3a4252;color:#fff">Später</button>';
  document.body.append(u);$('updX').onclick=()=>u.remove();
  $('updGo').onclick=async()=>{const t=$('updT'),g=$('updGo');g.disabled=true;t.textContent='Lade App '+neu+' …';
    try{await flushOutbox()}catch(e){}
    try{const r=await plug('Update','install',{url:davBase()+encPath(pfad),headers:{Authorization:'Basic '+b64utf8(cfg.user+':'+cfg.pass)}});
      if(r&&r.needPermission){t.textContent='Einmalig: „Apps aus dieser Quelle erlauben“ einschalten, zurück und nochmals tippen.';g.disabled=false;return}
      t.textContent='Android fragt jetzt: „Aktualisieren“ tippen.';g.disabled=false}
    catch(e){t.textContent='Update fehlgeschlagen: '+(e.message||e);g.disabled=false}}}
async function start(){
  $('startBtns').hidden=true;$('login').hidden=true;
  cfg=await sGet('nc');
  if(!cfg||!cfg.pass){if(C.isWeb&&pendingLink){showKunde(pendingLink);return}showLogin();return}
  window.__seg.root=cfg.root;
  msg('Werkzeuge werden aktualisiert …');
  try{const n=await syncTools();msg(n?n+' Werkzeug(e) aktualisiert':'Werkzeuge sind aktuell');flushOutbox();await openTools();updatePruefen()}
  catch(e){
    if(e instanceof AuthErr){msg('Anmeldung abgelaufen – bitte neu anmelden.',true);showLogin();return}
    const had=!!(await prefGet('toolsTime'));
    if(e instanceof NetErr&&had){const t=new Date(await prefGet('toolsTime'));showNet('Offline – Werkzeuge vom '+t.toLocaleDateString('de-CH')+' '+t.toLocaleTimeString('de-CH',{hour:'2-digit',minute:'2-digit'}),6000);await openTools();return}
    msg((e.message||String(e))+(had?'':'\n\nBeim ersten Start braucht die App Internet.')+(C.isWeb&&e instanceof NetErr?'\n\nKlappt es trotz Internet nicht: In Nextcloud muss die App „WebAppPassword“ diese Adresse erlauben ('+location.origin+').':''),true);$('startBtns').hidden=false;$('bOffline').hidden=!had}}

/* ---------------- Anmeldung im Browser: Benutzer + App-Passwort ---------------- */
async function loginWeb(){let srv=$('srv').value.trim().replace(/\/+$/,'');if(!/^https?:\/\//.test(srv))srv='https://'+srv;
  const user=$('wUser').value.trim(),pass=$('wPass').value.trim().replace(/\s+/g,''),root=norm($('rootIn').value||'/04-Vertrieb');
  if(!user||!pass){msg('Bitte Benutzername und App-Passwort eingeben.',true);return}
  cfg={server:srv,user,pass,root};msg('Prüfe Zugang …');$('bLogin').disabled=true;
  try{const r=await davRaw('PROPFIND','/',{slash:true,body:PROPS,contentType:'application/xml; charset=utf-8',headers:{Depth:'0'}});
    if(r.status!==207)throw new Error('Nextcloud antwortet mit '+r.status);
    await sSet('nc',cfg);await prefSet('toolsManifest',{});msg('Angemeldet als '+user);return start()}
  catch(e){cfg=null;msg(e instanceof AuthErr?'Benutzername oder App-Passwort falsch.':e instanceof NetErr?'Keine Verbindung zu Nextcloud.\n\nWenn Internet da ist: In Nextcloud unter Verwaltung → WebAppPassword muss diese Adresse erlaubt sein: '+location.origin:(e.message||String(e)),true)}
  finally{$('bLogin').disabled=false}}
/* ---------------- Kundenseite: QR-Code vom Etikett, gescannt von einem Kunden (nicht angemeldet) ---------------- */
const FIRMA={name:'Schmidhauser Segelmacherei GmbH',strasse:'Langrütistrasse 10',ort:'9403 Goldach',tel:'+41 71 245 50 50',mail:'info@segelmacherei.ch',web:'https://www.segelmacherei.ch',
  logo:'https://www.segelmacherei.ch/wp-content/uploads/2022/04/segelmacherei_schmidhauser_white.svg'};
function showKunde(P){const nr0=P&&P.get('nr')||'',nr=/^20\d{6}$/.test(nr0)?'':nr0, /* Datum statt Auftragsnummer (Projekt noch ohne Exxas-Nr.) nicht anzeigen */e=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const betreff='Service Sonnensegel'+(nr?' – Auftrag '+nr:''),body='Guten Tag\n\nIch habe eine Frage / brauche Service zu meinem Sonnensegel'+(nr?' (Auftrag '+nr+')':'')+'.\n\nName:\nAdresse:\nTelefon:\nAnliegen:\n\nFreundliche Grüsse';
  document.title='Ihr Sonnensegel – '+FIRMA.name;$('start').style.display='none';
  const d=document.createElement('div');d.id='kundeSeite';
  d.innerHTML=`<style>#kundeSeite{position:fixed;inset:0;overflow:auto;background:#0f1d33;display:flex;justify-content:center;padding:20px 14px 40px}
    #kundeSeite .k{max-width:480px;width:100%}#kundeSeite .kh{display:flex;align-items:center;justify-content:center;padding:10px 0 20px}#kundeSeite .kh img{height:58px;max-width:80%}
    #kundeSeite .kc{background:#fff;border-radius:16px;padding:24px 22px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
    #kundeSeite h1{font-size:23px;margin:0 0 6px;line-height:1.25}#kundeSeite .nr{display:inline-block;background:#eef3fb;color:#1a4fa0;border-radius:999px;padding:4px 12px;font-weight:600;font-size:14px;margin:4px 0 14px}
    #kundeSeite p{color:#4a5363;font-size:15.5px;line-height:1.5;margin:8px 0}
    #kundeSeite a.kb{display:flex;align-items:center;gap:12px;text-decoration:none;color:#1d2433;border:1px solid #d7dce5;border-radius:12px;padding:14px 16px;margin-top:10px;font-size:17px;font-weight:600}
    #kundeSeite a.kb.pri{background:#1a73e8;border-color:#1a73e8;color:#fff}#kundeSeite a.kb small{display:block;font-weight:400;font-size:13.5px;opacity:.8}
    #kundeSeite h2{font-size:16px;margin:22px 0 6px}#kundeSeite ul{margin:0;padding-left:20px;color:#4a5363;font-size:15px;line-height:1.55}
    #kundeSeite .kf{color:#aab3c5;font-size:13.5px;text-align:center;margin-top:18px;line-height:1.6}#kundeSeite .kf a{color:#cfd6e4}
    #kundeSeite button{font:inherit;font-size:13px;background:none;border:0;color:#7f8aa0;margin-top:14px;cursor:pointer;text-decoration:underline}</style>
   <div class="k"><div class="kh"><img src="${FIRMA.logo}" alt="${e(FIRMA.name)}"></div>
    <div class="kc"><h1>Ihr Sonnensegel von der Segelmacherei</h1>${nr?`<span class="nr">Auftrag ${e(nr)}</span>`:''}
     <p>Danke, dass Sie sich für ein Segel aus unserer Werkstatt entschieden haben. Bei Fragen, Service oder Ersatzteilen sind wir gerne für Sie da${nr?' – die Auftragsnummer hilft uns, Ihr Segel sofort zu finden':''}.</p>
     <a class="kb pri" href="mailto:${FIRMA.mail}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(body)}">✉<span>Service oder Ersatzteil anfragen<small>E-Mail an ${e(FIRMA.mail)}${nr?' mit Ihrer Auftragsnummer':''}</small></span></a>
     <a class="kb" href="tel:${FIRMA.tel.replace(/\s/g,'')}">📞<span>Anrufen<small>${e(FIRMA.tel)}</small></span></a>
     <a class="kb" href="${FIRMA.web}" target="_blank" rel="noopener">🌐<span>Zur Webseite<small>www.segelmacherei.ch</small></span></a>
     <h2>Pflege-Tipps</h2><ul><li>Bei Sturm, starkem Wind oder Schnee das Segel einrollen bzw. abnehmen.</li><li>Über den Winter trocken und sauber eingelagert aufbewahren.</li><li>Reinigen mit Wasser und milder Seife – keinen Hochdruckreiniger.</li><li>Spanner und Befestigungen ab und zu kontrollieren.</li></ul></div>
    <div class="kf"><b>${e(FIRMA.name)}</b><br>${e(FIRMA.strasse)} · ${e(FIRMA.ort)}<br><a href="${FIRMA.web}" target="_blank" rel="noopener">www.segelmacherei.ch</a><br><button type="button" id="kMa">Mitarbeiter-Anmeldung</button></div></div>`;
  document.body.append(d);const lg=d.querySelector('.kh img');lg.addEventListener('error',()=>{const b=document.createElement('b');b.style.cssText='color:#fff;font-size:20px';b.textContent=FIRMA.name;lg.replaceWith(b)});
  $('kMa').onclick=()=>{d.remove();$('start').style.display='';document.title='Segelmacherei Werkzeuge';showLogin()}}
/* ---------------- Anmeldung (Nextcloud Login Flow v2) ---------------- */
function showLogin(){$('login').hidden=false;$('startBtns').hidden=true;if(C.isWeb){$('webLogin').hidden=false;$('bLogin').textContent='Anmelden'}if(!$('msg').classList.contains('bad'))msg(C.isWeb?'Einmalig anmelden mit einem App-Passwort aus Nextcloud (Einstellungen → Sicherheit → „Neues App-Passwort erstellen“). Es kann dort jederzeit gesperrt werden.':'Einmalig mit dem Nextcloud-Konto anmelden. Das Passwort wird nicht in der App gespeichert – Nextcloud gibt der App ein eigenes App-Passwort, das man in Nextcloud jederzeit sperren kann.')}
async function login(){if(C.isWeb)return loginWeb();
  let srv=$('srv').value.trim().replace(/\/+$/,'');if(!/^https?:\/\//.test(srv))srv='https://'+srv;
  const root=norm($('rootIn').value||'/04-Vertrieb');
  msg('Verbinde mit '+srv+' …');$('bLogin').disabled=true;
  try{const r=await plug('Dav','request',{method:'POST',url:srv+'/index.php/login/v2',headers:{'User-Agent':'Segelmacherei Tablet'},responseType:'text'});
    if(r.status!==200)throw new Error('Nextcloud antwortet nicht wie erwartet ('+r.status+')');
    const j=JSON.parse(r.data);await plug('Browser','open',{url:j.login}).catch(()=>window.open(j.login,'_blank'));
    msg('Bitte im geöffneten Fenster anmelden und „Zugriff gewähren“ tippen …');
    const t0=Date.now();
    while(Date.now()-t0<10*60000){await new Promise(z=>setTimeout(z,2000));
      const p=await plug('Dav','request',{method:'POST',url:j.poll.endpoint,body:'token='+encodeURIComponent(j.poll.token),contentType:'application/x-www-form-urlencoded',responseType:'text'}).catch(()=>null);
      if(p&&p.status===200){const a=JSON.parse(p.data);cfg={server:(a.server||srv).replace(/\/+$/,''),user:a.loginName,pass:a.appPassword,root};await sSet('nc',cfg);
        plug('Browser','close',{}).catch(()=>{});msg('Angemeldet als '+cfg.user);await prefSet('toolsManifest',{});return start()}}
    throw new Error('Zeit abgelaufen – bitte nochmals versuchen.')}
  catch(e){msg(e.message||String(e),true)}finally{$('bLogin').disabled=false}}
async function logout(){if(!confirm(C.isWeb?'Abmelden? Nicht hochgeladene Änderungen bleiben in diesem Browser gespeichert. Gespeicherte Anmeldungen der Werkzeuge (z.B. Exxas) werden gelöscht.':'Abmelden? Nicht hochgeladene Änderungen bleiben auf dem Tablet gespeichert.'))return;const c=await sGet('nc');if(c){c.pass='';await sSet('nc',c)}
  /* Im Browser (evtl. fremder/gemeinsamer PC): auch die Geheimnisse der Werkzeuge löschen */
  if(C.isWeb)try{const k=await plug('Preferences','keys');for(const x of (k&&k.keys)||[])if(/^geheim:/.test(x))await plug('Preferences','remove',{key:x})}catch(e){}
  location.reload()}

$('bLogin').onclick=login;$('bAdv').onclick=()=>{$('adv').hidden=!$('adv').hidden};
$('bRetry').onclick=start;$('bLogout').onclick=logout;$('bOffline').onclick=openTools;

/* Zurück-Taste: nicht versehentlich schliessen */
try{const A=C.Plugins&&C.Plugins.App;if(A&&A.addListener){A.addListener('backButton',()=>{if($('dlg').style.display==='flex'){$('dlgCancel').click();return}if(confirm('App schliessen?'))A.exitApp()});A.addListener('resume',()=>{flushOutbox();updatePruefen()});
  A.addListener('appUrlOpen',e=>appLink(e&&e.url))}
  if(!C.isWeb)plug('App','getLaunchUrl').then(r=>appLink(r&&r.url)).catch(()=>{})}catch(e){}

/* Schnittstelle für die Werkzeuge (shim.js) */
window.__seg={root:'/04-Vertrieb',list,stat,read,write,mkdir,remove,picker,share,openUrl,nav,showNet,flush:flushOutbox,scan,
  /* Für die Werkzeuge: z.B. Exxas-Anmeldung des API-Benutzers, damit sie sich nach 24 h selbst erneuert (nur in der App gespeichert, wie das Nextcloud-App-Passwort) */
  secret:{get:async k=>{const v=await sGet('geheim:'+k);return v==null?null:String(v)},set:async(k,v)=>{await sSet('geheim:'+k,String(v));return true},del:async k=>{await sSet('geheim:'+k,null);try{await plug('Preferences','remove',{key:'geheim:'+k})}catch(e){}return true}},
  onZendesk:f=>{zdHoerer=f;if(zdWartend){const d=zdWartend;zdWartend=null;setTimeout(()=>f(d),0)}},
  ...(C.isWeb?{}:{http,zdApp:true}),
  openProjekt:P=>openProjekt(P instanceof URLSearchParams?P:linkParams(P)),
  get online(){return online},get user(){return cfg&&cfg.user},logout};

if(!C.isWeb)plug('App','getInfo').then(i=>{if(i&&i.version)$('appVer').textContent='v'+i.version}).catch(()=>{});
start();
})();
