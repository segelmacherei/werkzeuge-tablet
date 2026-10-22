/* Segelmacherei Werkzeuge (Windows) – läuft in jeder Werkzeug-Seite (auch in den Rahmen) vor deren eigenem Code.
 * Bildet die Ordner-Schnittstelle des Browsers (showDirectoryPicker …) direkt auf den Nextcloud-Ordner ab:
 * kein „Ordner wählen“, keine „Zugriff erlauben“-Fragen mehr. Nur für lokale Werkzeug-Dateien (file://).
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function SHIM(N) {
  'use strict';
  if (window.__seg) return;
  const domErr = (name, msg) => { try { return new DOMException(msg, name); } catch (e) { const x = new Error(msg); x.name = name; return x; } };
  const chk = r => { if (r && r.__err) throw domErr(r.name || 'Error', r.message || 'Fehler'); return r; };
  const S = {
    root: '/04-Vertrieb', desktop: true,
    list: async p => chk(await N.list(p)),
    stat: async p => chk(await N.stat(p)),
    read: async p => chk(await N.read(p)),
    write: async (p, b) => chk(await N.write(p, b instanceof Uint8Array ? b : new Uint8Array(b || 0))),
    mkdir: async p => chk(await N.mkdir(p)),
    remove: async p => chk(await N.remove(p)),
    picker: async o => chk(await N.picker(o || {})),
    share: async (blob, name) => chk(await N.save(String(name || 'Datei'), new Uint8Array(await blob.arrayBuffer()))),
    openUrl: u => N.openUrl(String(u)),
    openPath: async p => chk(await N.openPath(p)),
    info: async () => chk(await N.info()),
    showNet() {},
    online: true,
    // Verschlüsselt auf diesem PC (Windows-Benutzerkonto), z.B. für die automatische Exxas-Erneuerung
    secret: { get: async k => chk(await N.secretGet(String(k))), set: async (k, v) => chk(await N.secretSet(String(k), String(v))), del: async k => chk(await N.secretDel(String(k))) }
  };
  try { Object.defineProperty(window, '__seg', { value: S, configurable: false, writable: false }); } catch (e) { window.__seg = S; }
  window.__segApp = true; window.__segDesktop = true;

  const norm = p => ('/' + String(p || '').split('/').filter(Boolean).join('/'));
  const MIME = { pdf: 'application/pdf', json: 'application/json', csv: 'text/csv', txt: 'text/plain', html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', dxf: 'application/dxf', step: 'application/step', stp: 'application/step', ics: 'text/calendar', xml: 'application/xml' };
  const mimeOf = n => MIME[(String(n).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  class Handle {
    constructor(path, kind) { this.__dav = 1; this.path = norm(path); this.kind = kind; this.name = this.path.split('/').pop() || ''; }
    async isSameEntry(o) { return !!o && o.path === this.path && o.kind === this.kind; }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  class DirHandle extends Handle {
    constructor(path) { super(path, 'directory'); }
    async _list() { const L = await S.list(this.path); if (!L) throw domErr('NotFoundError', 'Ordner nicht gefunden: ' + this.path); return L; }
    async getDirectoryHandle(name, opt = {}) {
      const p = norm(this.path + '/' + name), e = await S.stat(p);
      if (e) { if (!e.dir) throw domErr('TypeMismatchError', name + ' ist eine Datei'); return new DirHandle(p); }
      if (!opt.create) throw domErr('NotFoundError', 'Ordner nicht gefunden: ' + name);
      await S.mkdir(p); return new DirHandle(p);
    }
    async getFileHandle(name, opt = {}) {
      const p = norm(this.path + '/' + name), e = await S.stat(p);
      if (e) { if (e.dir) throw domErr('TypeMismatchError', name + ' ist ein Ordner'); return new FileHandle(p, e); }
      if (!opt.create) throw domErr('NotFoundError', 'Datei nicht gefunden: ' + name);
      await S.write(p, new Uint8Array(0)); return new FileHandle(p, { size: 0, mtime: Date.now() });
    }
    async removeEntry(name) { await S.remove(norm(this.path + '/' + name)); }
    async resolve(h) { if (!h || !h.path || !(h.path + '/').startsWith(this.path + '/')) return null; return h.path.slice(this.path.length).split('/').filter(Boolean); }
    async *entries() { const L = await this._list(); for (const e of L) yield [e.name, e.dir ? new DirHandle(e.path) : new FileHandle(e.path, e)]; }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    async *keys() { for await (const [n] of this.entries()) yield n; }
    [Symbol.asyncIterator]() { return this.entries(); }
  }
  class FileHandle extends Handle {
    constructor(path, meta) { super(path, 'file'); if (meta) this._m = { size: meta.size || 0, mtime: meta.mtime || 0 }; }
    async getFile() { const r = await S.read(this.path); return new File([r.bytes], this.name, { type: mimeOf(this.name), lastModified: r.mtime || Date.now() }); }
    async createWritable(opt = {}) {
      const self = this; let buf = new Uint8Array(0), pos = 0, closed = false;
      if (opt.keepExistingData) { try { buf = new Uint8Array(await (await self.getFile()).arrayBuffer()); } catch (e) {} }
      const toBytes = async d => {
        if (d == null) return new Uint8Array(0); if (typeof d === 'string') return new TextEncoder().encode(d);
        if (d instanceof Blob) return new Uint8Array(await d.arrayBuffer()); if (d instanceof ArrayBuffer) return new Uint8Array(d);
        if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength); return new TextEncoder().encode(String(d));
      };
      const put = (b, at) => { const end = at + b.length; if (end > buf.length) { const n = new Uint8Array(end); n.set(buf); buf = n; } buf.set(b, at); pos = end; };
      return {
        async write(d) {
          if (d && typeof d === 'object' && !(d instanceof Blob) && !ArrayBuffer.isView(d) && !(d instanceof ArrayBuffer) && 'type' in d) {
            if (d.type === 'seek') { pos = d.position; return; }
            if (d.type === 'truncate') { buf = buf.slice(0, d.size); if (pos > d.size) pos = d.size; return; }
            put(await toBytes(d.data), d.position != null ? d.position : pos); return;
          }
          put(await toBytes(d), pos);
        },
        async seek(p) { pos = p; }, async truncate(n) { buf = buf.slice(0, n); if (pos > n) pos = n; },
        async close() { if (closed) return; closed = true; await S.write(self.path, buf); },
        async abort() { closed = true; },
        getWriter() { const w = this; return { write: d => w.write(d), close: () => w.close(), releaseLock() {} }; }
      };
    }
  }
  const revive = o => { if (!o || typeof o !== 'object') return o; if (o.__dav === 1 && o.path && !(o instanceof Handle)) return o.kind === 'file' ? new FileHandle(o.path) : new DirHandle(o.path); return o; };

  /* „04-Vertrieb“ ist immer der Nextcloud-Ordner; andere Ordner über den Windows-Dialog */
  window.showDirectoryPicker = async function (opt = {}) {
    if (!opt || opt.id === 'vertrieb' || (opt.id == null && !opt.startIn)) return new DirHandle(S.root);
    const start = opt.startIn && opt.startIn.path ? opt.startIn.path : S.root;
    return new DirHandle(await S.picker({ mode: 'dir', start, title: 'Ordner wählen' }));
  };
  window.showSaveFilePicker = async function (opt = {}) {
    const start = opt.startIn && opt.startIn.path ? (opt.startIn.kind === 'file' ? opt.startIn.path.replace(/\/[^/]*$/, '') : opt.startIn.path) : S.root;
    return new FileHandle(await S.picker({ mode: 'save', start, suggestedName: opt.suggestedName || 'Datei', types: opt.types || [] }));
  };
  window.showOpenFilePicker = function (opt = {}) {
    return new Promise((res, rej) => {
      const i = document.createElement('input'); i.type = 'file'; i.multiple = !!opt.multiple;
      const acc = []; (opt.types || []).forEach(t => Object.entries(t.accept || {}).forEach(([m, ex]) => { acc.push(m); (ex || []).forEach(e => acc.push(e)); }));
      if (acc.length) i.accept = acc.join(',');
      i.onchange = () => { const fs = [...i.files]; if (!fs.length) { rej(domErr('AbortError', 'Abgebrochen')); return; }
        res(fs.map(f => ({ kind: 'file', name: f.name, getFile: async () => f, queryPermission: async () => 'granted', requestPermission: async () => 'granted', isSameEntry: async o => o && o.name === f.name }))); };
      i.addEventListener('cancel', () => rej(domErr('AbortError', 'Abgebrochen'))); i.click();
    });
  };

  /* In IndexedDB gespeicherte Ordner wieder lebendig machen */
  // Beim allerersten Start ist der Hauptordner evtl. noch nicht gespeichert → Abfrage nach „vertrieb“ liefert ihn trotzdem
  const VERTRIEB = new WeakSet();
  try { const og = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (k) { const r = og.apply(this, arguments); try { if (this.name === 'h' && k === 'vertrieb') VERTRIEB.add(r); } catch (e) {} return r; }; } catch (e) {}
  try { const d = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
    if (d && d.get) Object.defineProperty(IDBRequest.prototype, 'result', { configurable: true, enumerable: d.enumerable, get() { const v = revive(d.get.call(this)); return v == null && VERTRIEB.has(this) ? new DirHandle(S.root) : v; } }); } catch (e) {}
  try { const d = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, 'value');
    if (d && d.get) Object.defineProperty(IDBCursorWithValue.prototype, 'value', { configurable: true, enumerable: d.enumerable, get() { return revive(d.get.call(this)); } }); } catch (e) {}
  // Der Hauptordner (04-Vertrieb) ist immer verbunden
  try { const r = indexedDB.open('werkzeuge', 1); r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => { try { const db = r.result; if (!db.objectStoreNames.contains('h')) return; const tx = db.transaction('h', 'readwrite');
      tx.objectStore('h').put({ __dav: 1, path: S.root, kind: 'directory', name: '04-Vertrieb' }, 'vertrieb'); tx.oncomplete = () => db.close(); } catch (e) {} }; } catch (e) {}
}

if (location.protocol === 'file:') {
  const call = (k, ...a) => ipcRenderer.invoke('seg', k, ...a);
  const N = {
    list: v => call('list', v), stat: v => call('stat', v), read: v => call('read', v), write: (v, b) => call('write', v, b),
    mkdir: v => call('mkdir', v), remove: v => call('remove', v), picker: o => call('picker', o), save: (n, b) => call('save', n, b),
    openUrl: u => call('openUrl', u), openPath: v => call('openPath', v), info: () => call('info'),
    secretGet: k => call('secretGet', k), secretSet: (k, v) => call('secretSet', k, v), secretDel: k => call('secretDel', k)
  };
  try {
    contextBridge.executeInMainWorld({ func: SHIM, args: [N] });
  } catch (e) {
    // Ältere Electron-Version: Schnittstelle bereitstellen und den Rest nachladen
    contextBridge.exposeInMainWorld('__segNative', N);
    console.error('Segelmacherei: executeInMainWorld nicht verfügbar', e);
  }
}
