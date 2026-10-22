/* Segelmacherei Tablet-App: Dateizugriff für die Werkzeuge.
 * Bildet die File System Access API (showDirectoryPicker, FileSystemDirectoryHandle …) über Nextcloud (WebDAV) nach,
 * damit Werkzeuge.html und die Werkzeuge unverändert in den Projektordnern arbeiten.
 * Wird von der App beim Herunterladen in jede Werkzeug-Datei eingefügt.
 */
(function(){
'use strict';
let S=null;{let w=window;for(let i=0;i<8&&w;i++){try{if(w.__seg){S=w.__seg;break}}catch(e){break}if(w===w.parent)break;w=w.parent}}
if(!S)return; // nicht in der App
window.__segApp=true;
const norm=p=>('/'+String(p||'').split('/').filter(Boolean).join('/'));
const MIME={pdf:'application/pdf',json:'application/json',csv:'text/csv',txt:'text/plain',html:'text/html',htm:'text/html',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',dxf:'application/dxf',step:'application/step',stp:'application/step',ics:'text/calendar',xml:'application/xml'};
const mimeOf=n=>MIME[(String(n).split('.').pop()||'').toLowerCase()]||'application/octet-stream';
const domErr=(name,msg)=>{try{return new DOMException(msg,name)}catch(e){const x=new Error(msg);x.name=name;return x}};

class Handle{constructor(path,kind){this.__dav=1;this.path=norm(path);this.kind=kind;this.name=this.path.split('/').pop()||''}
  async isSameEntry(o){return !!o&&o.path===this.path&&o.kind===this.kind}
  async queryPermission(){return 'granted'}
  async requestPermission(){return 'granted'}}

class DirHandle extends Handle{constructor(path){super(path,'directory')}
  async _list(){const L=await S.list(this.path);if(!L)throw domErr('NotFoundError','Ordner nicht gefunden: '+this.path);return L}
  async getDirectoryHandle(name,opt={}){const p=norm(this.path+'/'+name),L=await this._list(),e=L.find(x=>x.name===name);
    if(e){if(!e.dir)throw domErr('TypeMismatchError',name+' ist eine Datei');return new DirHandle(p)}
    if(!opt.create)throw domErr('NotFoundError','Ordner nicht gefunden: '+name);await S.mkdir(p);return new DirHandle(p)}
  async getFileHandle(name,opt={}){const p=norm(this.path+'/'+name),L=await this._list(),e=L.find(x=>x.name===name);
    if(e){if(e.dir)throw domErr('TypeMismatchError',name+' ist ein Ordner');return new FileHandle(p,e)}
    if(!opt.create)throw domErr('NotFoundError','Datei nicht gefunden: '+name);await S.write(p,new Uint8Array(0));return new FileHandle(p,{size:0,mtime:Date.now()})}
  async removeEntry(name){await S.remove(norm(this.path+'/'+name))}
  async resolve(h){if(!h||!h.path||!(h.path+'/').startsWith(this.path+'/'))return null;return h.path.slice(this.path.length).split('/').filter(Boolean)}
  async *entries(){const L=await this._list();for(const e of L)yield [e.name,e.dir?new DirHandle(e.path):new FileHandle(e.path,e)]}
  async *values(){for await(const [,h] of this.entries())yield h}
  async *keys(){for await(const [n] of this.entries())yield n}
  [Symbol.asyncIterator](){return this.entries()}}

class FileHandle extends Handle{constructor(path,meta){super(path,'file');if(meta)this._m={size:meta.size||0,mtime:meta.mtime||0}}
  async getFile(){const r=await S.read(this.path);return new File([r.bytes],this.name,{type:mimeOf(this.name),lastModified:r.mtime||(this._m&&this._m.mtime)||Date.now()})}
  async createWritable(opt={}){const self=this;let buf=new Uint8Array(0),pos=0;
    if(opt.keepExistingData){try{buf=new Uint8Array(await (await self.getFile()).arrayBuffer())}catch(e){}}
    const toBytes=async d=>{if(d==null)return new Uint8Array(0);if(typeof d==='string')return new TextEncoder().encode(d);if(d instanceof Blob)return new Uint8Array(await d.arrayBuffer());
      if(d instanceof ArrayBuffer)return new Uint8Array(d);if(ArrayBuffer.isView(d))return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);return new TextEncoder().encode(String(d))};
    const put=(b,at)=>{const end=at+b.length;if(end>buf.length){const n=new Uint8Array(end);n.set(buf);buf=n}buf.set(b,at);pos=end};
    let closed=false;
    return {
      async write(d){if(d&&typeof d==='object'&&!(d instanceof Blob)&&!ArrayBuffer.isView(d)&&!(d instanceof ArrayBuffer)&&'type' in d){
          if(d.type==='seek'){pos=d.position;return}if(d.type==='truncate'){buf=buf.slice(0,d.size);if(pos>d.size)pos=d.size;return}
          put(await toBytes(d.data),d.position!=null?d.position:pos);return}
        put(await toBytes(d),pos)},
      async seek(p){pos=p},async truncate(n){buf=buf.slice(0,n);if(pos>n)pos=n},
      async close(){if(closed)return;closed=true;await S.write(self.path,buf)},
      async abort(){closed=true},
      getWriter(){const w=this;return {write:d=>w.write(d),close:()=>w.close(),releaseLock(){}}}}}}

const revive=o=>{if(!o||typeof o!=='object')return o;if(o.__dav===1&&o.path&&!(o instanceof Handle))return o.kind==='file'?new FileHandle(o.path):new DirHandle(o.path);return o};

/* Ordner-Auswahl: „04-Vertrieb“ ist immer der Nextcloud-Ordner; andere über den Dialog der App */
window.showDirectoryPicker=async function(opt={}){
  if(!opt||opt.id==='vertrieb'||opt.id==null&&!opt.startIn)return new DirHandle(S.root);
  const start=opt.startIn&&opt.startIn.path?opt.startIn.path:S.root;
  return new DirHandle(await S.picker({mode:'dir',start,title:'Ordner wählen'}))};
window.showSaveFilePicker=async function(opt={}){
  const start=opt.startIn&&opt.startIn.path?(opt.startIn.kind==='file'?opt.startIn.path.replace(/\/[^/]*$/,''):opt.startIn.path):S.root;
  const p=await S.picker({mode:'save',start,suggestedName:opt.suggestedName||'Datei'});return new FileHandle(p)};
window.showOpenFilePicker=function(opt={}){return new Promise((res,rej)=>{const i=document.createElement('input');i.type='file';i.multiple=!!opt.multiple;
  const acc=[];(opt.types||[]).forEach(t=>Object.entries(t.accept||{}).forEach(([m,ex])=>{acc.push(m);(ex||[]).forEach(e=>acc.push(e))}));if(acc.length)i.accept=acc.join(',');
  i.onchange=()=>{const fs=[...i.files];if(!fs.length){rej(domErr('AbortError','Abgebrochen'));return}
    res(fs.map(f=>({kind:'file',name:f.name,getFile:async()=>f,queryPermission:async()=>'granted',requestPermission:async()=>'granted',isSameEntry:async o=>o&&o.name===f.name})))};
  i.addEventListener('cancel',()=>rej(domErr('AbortError','Abgebrochen')));i.click()})};

/* In IndexedDB gespeicherte Handles wieder lebendig machen */
try{const d=Object.getOwnPropertyDescriptor(IDBRequest.prototype,'result');
  if(d&&d.get)Object.defineProperty(IDBRequest.prototype,'result',{configurable:true,enumerable:d.enumerable,get(){return revive(d.get.call(this))}})}catch(e){}
try{const d=Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype,'value');
  if(d&&d.get)Object.defineProperty(IDBCursorWithValue.prototype,'value',{configurable:true,enumerable:d.enumerable,get(){return revive(d.get.call(this))}})}catch(e){}
// Die Wurzel (04-Vertrieb) ist in der App immer verbunden
try{const r=indexedDB.open('werkzeuge',1);r.onupgradeneeded=()=>r.result.createObjectStore('h');
  r.onsuccess=()=>{try{const db=r.result;if(!db.objectStoreNames.contains('h'))return;const tx=db.transaction('h','readwrite');tx.objectStore('h').put({__dav:1,path:norm(S.root),kind:'directory',name:norm(S.root).split('/').pop()},'vertrieb');tx.oncomplete=()=>db.close()}catch(e){}}}catch(e){}

/* Downloads (a.download, Blob-Links) → Teilen-Dialog des Tablets */
async function dl(href,name){try{const b=await (await fetch(href)).blob();await S.share(b,name||'Datei')}catch(e){S.showNet('Download nicht möglich: '+(e.message||e),4000)}}
const aClick=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&/^(blob:|data:)/.test(this.href)){dl(this.href,this.getAttribute('download')||this.download);return}
  if(this.target==='_blank'&&/^https?:/.test(this.href)){S.openUrl(this.href);return}return aClick.call(this)};
document.addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;
  if(a.hasAttribute('download')&&/^(blob:|data:)/.test(a.href)){e.preventDefault();dl(a.href,a.getAttribute('download'));return}
  if((a.target==='_blank'||a.target==='_top')&&/^https?:/.test(a.href)&&!a.href.startsWith(location.origin)){e.preventDefault();S.openUrl(a.href)}},true);
const wOpen=window.open;
window.open=function(u,t,f){const s=String(u||'');if(/^https?:/.test(s)&&!s.startsWith(location.origin)){S.openUrl(s);return null}
  if(/^blob:/.test(s)){dl(s,'Dokument.pdf');return null}return wOpen.call(window,u,t,f)};

/* Tablet: etwas grössere Bedienelemente */
const st=document.createElement('style');st.textContent='@media (pointer:coarse){button,select,input,.btn{min-height:40px}input[type=checkbox],input[type=radio]{width:22px;height:22px}}';
(document.head||document.documentElement).appendChild(st);
})();
