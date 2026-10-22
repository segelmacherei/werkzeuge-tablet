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

/* ---------------- Hilfen ---------------- */
const b64utf8=s=>btoa(unescape(encodeURIComponent(s)));
function bytesToB64(u8){let s='';const n=0x8000;for(let i=0;i<u8.length;i+=n)s+=String.fromCharCode.apply(null,u8.subarray(i,i+n));return btoa(s)}
function b64ToBytes(b){const s=atob(b||'');const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u}
const norm=p=>('/'+String(p||'').split('/').filter(Boolean).join('/'));
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
  if(r.status===401)throw new AuthErr();
  return r}
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

async function read(path){path=norm(path);await loadOutbox();const ob=obFind(path);
  if(ob&&!ob.del){const b=await fsR(ob.file);return {bytes:b64ToBytes(b),mtime:ob.t}}
  try{const r=await davRaw('GET',path,{responseType:'base64'});if(r.status===404)throw Object.assign(new Error('Datei nicht gefunden: '+path),{name:'NotFoundError'});
    if(r.status>=300)throw new Error('Lesefehler '+r.status);
    const lm=Date.parse((r.headers||{})['last-modified'])||Date.now();
    if((r.data||'').length<15e6)fsW(cacheFile(path),r.data).catch(()=>{});
    return {bytes:b64ToBytes(r.data),mtime:lm}}
  catch(e){if(!(e instanceof NetErr))throw e;try{const b=await fsR(cacheFile(path));return {bytes:b64ToBytes(b),mtime:0}}catch(_){throw new NetErr('Offline – diese Datei ist auf dem Tablet nicht gespeichert: '+nameOf(path))}}}

async function write(path,bytes){path=norm(path);await loadOutbox();const b64=bytesToB64(bytes);
  const put=()=>davRaw('PUT',path,{bodyBase64:b64,contentType:'application/octet-stream'});
  try{let r=await put();if(r.status===409||r.status===404){await davMkcolDeep(parentOf(path));r=await put()}
    if(r.status>=300)throw new Error('Speichern fehlgeschlagen ('+r.status+')');
    mem.delete(parentOf(path));fsW(cacheFile(path),b64).catch(()=>{});
    const i=outbox.findIndex(o=>o.path===path);if(i>=0){fsDel(outbox[i].file);outbox.splice(i,1);saveOutbox()}
    return {offline:false}}
  catch(e){if(!(e instanceof NetErr))throw e;
    const file='ob/'+Date.now()+'-'+Math.random().toString(36).slice(2,8);await fsW(file,b64);
    const i=outbox.findIndex(o=>o.path===path);if(i>=0){fsDel(outbox[i].file);outbox.splice(i,1)}
    outbox.push({path,file,t:Date.now(),size:bytes.length});await saveOutbox();fsW(cacheFile(path),b64).catch(()=>{});
    showNet('Offline gespeichert: '+nameOf(path)+' – wird hochgeladen, sobald Netz da ist',5000);return {offline:true}}}

async function mkdir(path){path=norm(path);try{const r=await davRaw('MKCOL',path);if(r.status===409){await davMkcolDeep(path)}else if(r.status!==201&&r.status!==405)throw new Error('Ordner konnte nicht erstellt werden ('+r.status+')');mem.delete(parentOf(path))}
  catch(e){if(!(e instanceof NetErr))throw e;/* offline: Ordner entsteht beim Hochladen */}}
async function remove(path){path=norm(path);try{const r=await davRaw('DELETE',path);if(r.status>=300&&r.status!==404)throw new Error('Löschen fehlgeschlagen ('+r.status+')');mem.delete(parentOf(path))}
  catch(e){if(!(e instanceof NetErr))throw e;await loadOutbox();outbox=outbox.filter(o=>o.path!==path);outbox.push({path,del:true,t:Date.now()});await saveOutbox()}}

let flushing=false;
async function flushOutbox(){await loadOutbox();if(flushing||!outbox.length||!cfg)return;flushing=true;let n=0;
  try{for(const o of outbox.slice()){
      if(o.del){const r=await davRaw('DELETE',o.path);if(r.status<300||r.status===404){outbox=outbox.filter(x=>x!==o);n++}continue}
      const b64=await fsR(o.file);let r=await davRaw('PUT',o.path,{bodyBase64:b64,contentType:'application/octet-stream'});
      if(r.status===409||r.status===404){await davMkcolDeep(parentOf(o.path));r=await davRaw('PUT',o.path,{bodyBase64:b64,contentType:'application/octet-stream'})}
      if(r.status<300){fsDel(o.file);outbox=outbox.filter(x=>x!==o);mem.delete(parentOf(o.path));n++}}
  }catch(e){}finally{await saveOutbox();flushing=false;if(n)showNet(n===1?'1 Datei hochgeladen':n+' Dateien hochgeladen',3000)}}
setInterval(()=>{if(cfg)flushOutbox()},60000);
window.addEventListener('online',()=>flushOutbox());

/* ---------------- Teilen / Öffnen ---------------- */
async function share(blob,name){const b=new Uint8Array(await blob.arrayBuffer());const path='export/'+name.replace(/[\\/:*?"<>|]/g,'_');
  await plug('Filesystem','writeFile',{path,data:bytesToB64(b),directory:FS.CACHE,recursive:true});
  const u=await plug('Filesystem','getUri',{path,directory:FS.CACHE});
  try{await plug('Share','share',{title:name,files:[u.uri],dialogTitle:name})}catch(e){if(!/cancel/i.test(String(e&&e.message)))showNet('Teilen nicht möglich: '+(e.message||e),4000)}}
async function openUrl(url){try{await plug('Browser','open',{url})}catch(e){window.open(url,'_blank')}}

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
  $('dlgNew').onclick=async()=>{const n=prompt('Name des neuen Ordners');if(!n)return;await mkdir(cur+'/'+n);cur=norm(cur+'/'+n);show()};
  $('dlgCancel').onclick=()=>{close();const e=new Error('Abgebrochen');e.name='AbortError';rej(e)};
  $('dlgOk').onclick=()=>{if(mode==='save'){const n=N.value.trim();if(!n){N.focus();return}close();res(norm(cur+'/'+n))}else{close();res(cur)}};
  D.style.display='flex';show()})}

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
  const todo=want.filter(w=>man[w.rel]!==w.e.etag);let i=0;
  for(const w of todo){msg('Lade '+w.rel.split('/').pop()+' …');bar(i/todo.length);
    const r=await davRaw('GET',w.e.path,{responseType:'text'});if(r.status!==200)throw new Error(w.rel+': Fehler '+r.status);
    await fsW('w/'+w.rel,inject(r.data),'utf8');man[w.rel]=w.e.etag;i++}
  bar(null);await prefSet('toolsManifest',man);await prefSet('toolsTime',Date.now());return todo.length}

async function openTools(){if(window.__swReady)await window.__swReady;const u=await plug('Filesystem','getUri',{path:'w/'+TOOL_HOST,directory:FS.DATA});
  const src=typeof C.convertFileSrc==='function'?C.convertFileSrc(u.uri):u.uri;
  const f=$('app');f.src=src;f.style.display='block';$('start').style.display='none'}

async function start(){
  $('startBtns').hidden=true;$('login').hidden=true;
  cfg=await prefGet('nc');
  if(!cfg||!cfg.pass){showLogin();return}
  window.__seg.root=cfg.root;
  msg('Werkzeuge werden aktualisiert …');
  try{const n=await syncTools();msg(n?n+' Werkzeug(e) aktualisiert':'Werkzeuge sind aktuell');flushOutbox();await openTools()}
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
    await prefSet('nc',cfg);await prefSet('toolsManifest',{});msg('Angemeldet als '+user);return start()}
  catch(e){cfg=null;msg(e instanceof AuthErr?'Benutzername oder App-Passwort falsch.':e instanceof NetErr?'Keine Verbindung zu Nextcloud.\n\nWenn Internet da ist: In Nextcloud unter Verwaltung → WebAppPassword muss diese Adresse erlaubt sein: '+location.origin:(e.message||String(e)),true)}
  finally{$('bLogin').disabled=false}}
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
      if(p&&p.status===200){const a=JSON.parse(p.data);cfg={server:(a.server||srv).replace(/\/+$/,''),user:a.loginName,pass:a.appPassword,root};await prefSet('nc',cfg);
        plug('Browser','close',{}).catch(()=>{});msg('Angemeldet als '+cfg.user);await prefSet('toolsManifest',{});return start()}}
    throw new Error('Zeit abgelaufen – bitte nochmals versuchen.')}
  catch(e){msg(e.message||String(e),true)}finally{$('bLogin').disabled=false}}
async function logout(){if(!confirm('Abmelden? Nicht hochgeladene Änderungen bleiben auf dem Tablet gespeichert.'))return;const c=await prefGet('nc');if(c){c.pass='';await prefSet('nc',c)}location.reload()}

$('bLogin').onclick=login;$('bAdv').onclick=()=>{$('adv').hidden=!$('adv').hidden};
$('bRetry').onclick=start;$('bLogout').onclick=logout;$('bOffline').onclick=openTools;

/* Zurück-Taste: nicht versehentlich schliessen */
try{const A=C.Plugins&&C.Plugins.App;if(A&&A.addListener){A.addListener('backButton',()=>{if($('dlg').style.display==='flex'){$('dlgCancel').click();return}if(confirm('App schliessen?'))A.exitApp()});A.addListener('resume',()=>flushOutbox())}}catch(e){}

/* Schnittstelle für die Werkzeuge (shim.js) */
window.__seg={root:'/04-Vertrieb',list,stat,read,write,mkdir,remove,picker,share,openUrl,showNet,flush:flushOutbox,
  get online(){return online},get user(){return cfg&&cfg.user},logout};

start();
})();
