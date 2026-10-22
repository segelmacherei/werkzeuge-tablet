/* Segelmacherei Werkzeuge – Windows-Programm
 * Öffnet „04 Werkzeuge/Werkzeuge.html“ direkt aus dem Nextcloud-Ordner dieses PCs. Die Werkzeuge selbst
 * kommen also weiterhin aus der Nextcloud (Änderungen sind sofort auf allen PCs), das Programm liefert nur:
 *  – Ordnerzugriff ohne Nachfragen, – bleibende Anmeldungen (Exxas, Zendesk), – Links segelmacherei://kunde?id=… (Cloudya),
 *  – automatische Updates des Programms selbst (GitHub-Releases).
 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, session, nativeImage } = require('electron');
const path = require('path'), fs = require('fs'), fsp = fs.promises;
const kern = require('./kern');

const PROTO = 'segelmacherei';
app.setAppUserModelId('ch.segelmacherei.werkzeuge');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

/* ---------- Einstellungen dieses PCs ---------- */
const CFG = () => path.join(app.getPath('userData'), 'einstellungen.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG(), 'utf8')) || {}; } catch (e) { cfg = {}; }
const speichern = () => { try { fs.mkdirSync(path.dirname(CFG()), { recursive: true }); fs.writeFileSync(CFG(), JSON.stringify(cfg, null, 1)); } catch (e) {} };

/* ---------- Geheimnisse (z.B. Exxas-App-Passwort): mit Windows verschlüsselt, nur dieser Benutzer auf diesem PC ---------- */
const GEHEIM = () => path.join(app.getPath('userData'), 'geheim.json');
const geheimLesen = () => { try { return JSON.parse(fs.readFileSync(GEHEIM(), 'utf8')) || {}; } catch (e) { return {}; } };
const geheimSchreiben = o => { fs.mkdirSync(path.dirname(GEHEIM()), { recursive: true }); fs.writeFileSync(GEHEIM(), JSON.stringify(o)); };

let FS = null, win = null, startLink = null;
const ICON = path.join(__dirname, 'icon.png');

/* ---------- Link segelmacherei://kunde?id=123 → #kunde?id=123 ---------- */
function linkAus(argv) { const a = (argv || []).find(x => typeof x === 'string' && x.toLowerCase().startsWith(PROTO + ':')); return a || null; }
function hashAus(link) {
  try {
    const u = new URL(link);
    const ziel = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || 'kunde').toLowerCase();
    if (!/^[a-z0-9-]{1,30}$/.test(ziel)) return null;
    const q = new URLSearchParams(u.search); q.set('t', Date.now().toString(36)); // gleiche Nummer nochmals → trotzdem öffnen
    return '#' + ziel + '?' + q.toString();
  } catch (e) { return null; }
}
function oeffneLink(link) {
  const h = link && hashAus(link); if (!win) { startLink = link; return; }
  if (win.isMinimized()) win.restore(); win.show(); win.focus();
  if (h) win.webContents.executeJavaScript('location.hash=' + JSON.stringify(h)).catch(() => {});
}
startLink = linkAus(process.argv);
app.on('second-instance', (e, argv) => { const l = linkAus(argv); if (l) oeffneLink(l); else if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('open-url', (e, url) => { e.preventDefault(); oeffneLink(url); });
if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]); }
else app.setAsDefaultProtocolClient(PROTO);

/* ---------- Nextcloud-Ordner ---------- */
async function rootBestimmen(neuWaehlen) {
  let r = neuWaehlen ? null : kern.findeRoot(cfg.root);
  while (!r) {
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'Nextcloud-Ordner „04-Vertrieb“ wählen', buttonLabel: 'Diesen Ordner verwenden',
      defaultPath: cfg.root || path.join(require('os').homedir(), 'Nextcloud'), properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) { if (neuWaehlen && FS) return FS.root; return null; }
    r = kern.rootAusWahl(res.filePaths[0]);
    if (!r) await dialog.showMessageBox(win || undefined, { type: 'warning', title: 'Falscher Ordner', message: 'In diesem Ordner sind die Werkzeuge nicht zu finden.',
      detail: 'Bitte den Nextcloud-Ordner „04-Vertrieb“ wählen (darin liegt „04 Werkzeuge\\Werkzeuge.html“).' });
  }
  if (cfg.root !== r) { cfg.root = r; speichern(); }
  FS = kern.erstelle(r, { extra: cfg.extra || [], papierkorb: p => shell.trashItem(p) });
  return r;
}

/* ---------- Schnittstelle für die Werkzeuge (preload.js) ---------- */
const erlaubt = new Set(['list', 'stat', 'read', 'write', 'mkdir', 'remove', 'move', 'picker', 'save', 'openUrl', 'openPath', 'info', 'secretGet', 'secretSet', 'secretDel']);
ipcMain.handle('seg', async (ev, k, ...a) => {
  try {
    const url = (ev.senderFrame && ev.senderFrame.url) || '';
    if (!url.startsWith('file:')) return { __err: 1, name: 'SecurityError', message: 'Nicht erlaubt' };
    if (!erlaubt.has(k)) return { __err: 1, name: 'NotSupportedError', message: 'Unbekannt: ' + k };
    if (!FS) return { __err: 1, name: 'NotFoundError', message: 'Kein Nextcloud-Ordner gewählt' };
    switch (k) {
      case 'list': return await FS.list(a[0]);
      case 'stat': return await FS.stat(a[0]);
      case 'read': return await FS.read(a[0]);
      case 'write': return await FS.write(a[0], a[1]);
      case 'mkdir': return await FS.mkdir(a[0]);
      case 'remove': return await FS.remove(a[0]);
      case 'move': return await FS.move(a[0], a[1]);
      case 'picker': return await picker(a[0] || {});
      case 'save': return await sichern(String(a[0] || 'Datei'), a[1]);
      case 'openUrl': { const u = String(a[0] || ''); if (/^(https?|mailto|tel):/i.test(u)) await shell.openExternal(u); return true; }
      case 'openPath': { const r = FS.toReal(a[0]); const e = await shell.openPath(r); return e ? { __err: 1, name: 'NotFoundError', message: e } : true; }
      case 'info': return { version: app.getVersion(), root: FS.root, plattform: process.platform, verschluesselung: safeStorage.isEncryptionAvailable() };
      case 'secretGet': { const o = geheimLesen(), v = o[String(a[0])]; if (!v || !safeStorage.isEncryptionAvailable()) return null; try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch (e) { return null; } }
      case 'secretSet': { if (!safeStorage.isEncryptionAvailable()) return { __err: 1, name: 'NotSupportedError', message: 'Verschlüsselung nicht verfügbar' };
        const o = geheimLesen(); o[String(a[0])] = safeStorage.encryptString(String(a[1])).toString('base64'); geheimSchreiben(o); return true; }
      case 'secretDel': { const o = geheimLesen(); delete o[String(a[0])]; geheimSchreiben(o); return true; }
    }
  } catch (e) { return { __err: 1, name: e.name && e.name !== 'Error' ? e.name : (e.code === 'ENOENT' ? 'NotFoundError' : e.code === 'EACCES' || e.code === 'EPERM' ? 'NotAllowedError' : 'Error'), message: e.message || String(e) }; }
});
async function picker(o) {
  const startReal = (() => { try { return FS.toReal(o.start || kern.VROOT); } catch (e) { return FS.root; } })();
  if (o.mode === 'save') {
    const filters = [];
    (o.types || []).forEach(t => { const ex = []; Object.values(t.accept || {}).forEach(l => (l || []).forEach(x => ex.push(String(x).replace(/^\./, '')))); if (ex.length) filters.push({ name: t.description || ex.join(', '), extensions: ex }); });
    const r = await dialog.showSaveDialog(win, { title: o.title || 'Speichern unter', defaultPath: path.join(startReal, String(o.suggestedName || 'Datei')), filters: filters.length ? filters : undefined });
    if (r.canceled || !r.filePath) return { __err: 1, name: 'AbortError', message: 'Abgebrochen' };
    if (path.relative(FS.root, r.filePath).startsWith('..')) { FS.erlaube(path.dirname(r.filePath)); merkeExtra(path.dirname(r.filePath)); }
    return FS.toVirt(r.filePath);
  }
  const r = await dialog.showOpenDialog(win, { title: o.title || 'Ordner wählen', defaultPath: startReal, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { __err: 1, name: 'AbortError', message: 'Abgebrochen' };
  if (path.relative(FS.root, r.filePaths[0]).startsWith('..')) { FS.erlaube(r.filePaths[0]); merkeExtra(r.filePaths[0]); }
  return FS.toVirt(r.filePaths[0]);
}
function merkeExtra(p) { cfg.extra = [...new Set([...(cfg.extra || []), p])].slice(-20); speichern(); }
async function sichern(name, bytes) {
  const r = await dialog.showSaveDialog(win, { title: 'Speichern unter', defaultPath: path.join(cfg.ablage || app.getPath('downloads'), name.replace(/[\\/:*?"<>|]/g, '_')) });
  if (r.canceled || !r.filePath) return { __err: 1, name: 'AbortError', message: 'Abgebrochen' };
  await fsp.writeFile(r.filePath, Buffer.from(bytes || [])); cfg.ablage = path.dirname(r.filePath); speichern(); return true;
}

/* ---------- prompt() für die Werkzeuge (Electron kennt es nicht) ---------- */
ipcMain.on('seg-prompt', (ev, msg, def) => {
  let fertig = false;
  const parent = BrowserWindow.fromWebContents(ev.sender) || win;
  const p = new BrowserWindow({ parent, modal: true, width: 460, height: 210, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true,
    title: 'Eingabe', icon: nativeImage.createFromPath(ICON), show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>Eingabe</title><body style="margin:0;font:14px system-ui,'Segoe UI',Arial;padding:16px;background:#fff;color:#1d2330">
    <div style="white-space:pre-line;margin-bottom:10px">${esc(msg)}</div>
    <input id="i" value="${esc(def)}" style="width:100%;box-sizing:border-box;font-size:15px;padding:7px 9px;border:1px solid #c9ced6;border-radius:7px">
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button id="x" style="padding:6px 14px">Abbrechen</button><button id="o" style="padding:6px 14px;background:#1f6feb;color:#fff;border:1px solid #1f6feb;border-radius:6px">OK</button></div>
    <script>const i=document.getElementById('i');i.focus();i.select();const ok=()=>{document.title='OK:'+i.value},no=()=>{document.title='ABBRUCH'};
    document.getElementById('o').onclick=ok;document.getElementById('x').onclick=no;i.onkeydown=e=>{if(e.key==='Enter')ok();if(e.key==='Escape')no()};</script></body>`;
  const ende = v => { if (fertig) return; fertig = true; ev.returnValue = v; if (!p.isDestroyed()) p.destroy(); };
  p.webContents.on('page-title-updated', (e, t) => { if (t.startsWith('OK:')) ende(t.slice(3)); else if (t === 'ABBRUCH') ende(null); });
  p.on('closed', () => ende(null));
  p.once('ready-to-show', () => p.show());
  p.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});

/* ---------- Fenster ---------- */
function startHash() { const h = startLink && hashAus(startLink); startLink = null; return h ? h.slice(1) : undefined; }
function laden() {
  const datei = path.join(FS.root, '04 Werkzeuge', 'Werkzeuge.html');
  const h = startHash();
  return win.loadFile(datei, h ? { hash: h } : undefined);
}
function fenster() {
  const b = cfg.fenster || {};
  win = new BrowserWindow({
    width: b.width || 1400, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600, show: false,
    title: 'Segelmacherei Werkzeuge', icon: nativeImage.createFromPath(ICON), autoHideMenuBar: true, backgroundColor: '#1d2330',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: true, spellcheck: true }
  });
  if (b.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  const merke = () => { if (!win || win.isDestroyed()) return; const max = win.isMaximized(); cfg.fenster = { ...(max ? cfg.fenster || {} : win.getBounds()), max }; speichern(); };
  win.on('close', merke);
  win.on('closed', () => { win = null; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); });
  win.webContents.on('did-fail-load', (e, code, desc, url, main) => {
    if (main) dialog.showMessageBox(win, { type: 'error', title: 'Werkzeuge nicht gefunden', message: 'Die Werkzeuge konnten nicht geöffnet werden.', detail: desc + '\n' + url + '\n\nIst Nextcloud fertig synchronisiert? Sonst im Menü (Alt) „Nextcloud-Ordner wählen…“.' });
  });
  laden();
}
/* Neue Fenster: Zendesk-Anmeldung und PDF-Vorschau im Programm, alles andere im normalen Browser */
function fensterRegel(url) {
  const klein = { width: 560, height: 760, autoHideMenuBar: true, icon: nativeImage.createFromPath(ICON) };
  if (/^https:\/\/[a-z0-9-]+\.zendesk\.com\/(oauth|access|auth)\//i.test(url) || /^https:\/\/segelmacherei\.github\.io\/werkzeuge-tablet\/zendesk\.html/i.test(url))
    return { action: 'allow', overrideBrowserWindowOptions: { ...klein, webPreferences: { preload: undefined, nodeIntegrationInSubFrames: false, sandbox: true, contextIsolation: true } } };
  if (/^(blob:|file:|about:blank|data:application\/pdf)/i.test(url) || url === '')
    return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 850, autoHideMenuBar: true, icon: nativeImage.createFromPath(ICON) } };
  if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
  return { action: 'deny' };
}
/* Zendesk-Anmeldung: Rücksprung (zendesk.html?code=…) hier abfangen und an die Werkzeuge geben.
   Nötig, weil Zendesk die Verbindung zum öffnenden Fenster (window.opener) trennt. */
const ZD_RUECK = 'https://segelmacherei.github.io/werkzeuge-tablet/zendesk.html';
function zdFang(wc) {
  const f = (e, url) => {
    if (!String(url || '').startsWith(ZD_RUECK)) return;
    let u; try { u = new URL(url); } catch (x) { return; }
    const code = u.searchParams.get('code'), error = u.searchParams.get('error');
    if (!code && !error) return;
    e.preventDefault();
    if (win && !win.isDestroyed()) { win.webContents.send('seg-zd', { code, state: u.searchParams.get('state') || '', error, error_description: u.searchParams.get('error_description') || '' }); win.focus(); }
    const bw = BrowserWindow.fromWebContents(wc); if (bw && bw !== win) setTimeout(() => { try { bw.close(); } catch (x) {} }, 50);
  };
  wc.on('will-redirect', f); wc.on('will-navigate', f);
}
app.on('web-contents-created', (e, wc) => {
  zdFang(wc);
  // Zendesk-Fenster darf zwischen zendesk.com und github.io wechseln, sonst nichts
  // Anmeldefenster (Zendesk, evtl. Google/Microsoft-Login darin) dürfen weitere Anmelde-Fenster im Programm öffnen
  wc.setWindowOpenHandler(({ url }) => {
    const istHaupt = win && !win.isDestroyed() && wc === win.webContents;
    let eigen = ''; try { eigen = wc.getURL(); } catch (e) {}
    if (!istHaupt && /^https:/i.test(eigen) && /^https:/i.test(url))
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 760, autoHideMenuBar: true, icon: nativeImage.createFromPath(ICON) } };
    return fensterRegel(url);
  });
});

/* ---------- Menü (mit Alt sichtbar) ---------- */
function menue() {
  const autostart = app.getLoginItemSettings().openAtLogin;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Werkzeuge', submenu: [
      { label: 'Neu laden', accelerator: 'F5', click: () => win && win.webContents.reloadIgnoringCache() },
      { label: 'Zur Startseite', accelerator: 'Alt+Home', click: () => win && laden() },
      { type: 'separator' },
      { label: 'Nextcloud-Ordner öffnen', click: () => FS && shell.openPath(FS.root) },
      { label: 'Nextcloud-Ordner wählen …', click: async () => { await rootBestimmen(true); if (win) laden(); } },
      { label: 'Mit Windows starten', type: 'checkbox', checked: autostart, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked }); } },
      { type: 'separator' },
      { label: 'Beenden', accelerator: 'Alt+F4', role: 'quit' }
    ] },
    { label: 'Bearbeiten', submenu: [{ role: 'undo', label: 'Rückgängig' }, { role: 'redo', label: 'Wiederholen' }, { type: 'separator' }, { role: 'cut', label: 'Ausschneiden' }, { role: 'copy', label: 'Kopieren' }, { role: 'paste', label: 'Einfügen' }, { role: 'selectAll', label: 'Alles markieren' }] },
    { label: 'Ansicht', submenu: [{ role: 'zoomIn', label: 'Grösser', accelerator: 'Ctrl+=' }, { role: 'zoomOut', label: 'Kleiner' }, { role: 'resetZoom', label: 'Normalgrösse' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Vollbild' }, { role: 'toggleDevTools', label: 'Entwicklertools' }] },
    { label: 'Hilfe', submenu: [
      { label: 'Nach Updates suchen', click: () => updates(true) },
      { label: 'Über Segelmacherei Werkzeuge', click: () => dialog.showMessageBox(win, { title: 'Segelmacherei Werkzeuge', message: 'Segelmacherei Werkzeuge ' + app.getVersion(), detail: 'Nextcloud-Ordner:\n' + (FS ? FS.root : '–') + '\n\nElectron ' + process.versions.electron, icon: nativeImage.createFromPath(ICON) }) }
    ] }
  ]));
}

/* ---------- Automatische Updates (GitHub-Releases) ---------- */
let updaterBereit = false;
function updates(manuell) {
  if (!app.isPackaged) { if (manuell) dialog.showMessageBox(win, { message: 'Updates gibt es nur in der installierten Version.' }); return; }
  let au; try { au = require('electron-updater').autoUpdater; } catch (e) { return; }
  if (!updaterBereit) {
    updaterBereit = true; au.autoDownload = true; au.autoInstallOnAppQuit = true;
    au.on('update-downloaded', i => {
      dialog.showMessageBox(win, { type: 'info', buttons: ['Jetzt neu starten', 'Später'], defaultId: 0, cancelId: 1, title: 'Update bereit',
        message: 'Version ' + i.version + ' ist bereit.', detail: 'Das Programm startet kurz neu. Ungespeicherte Eingaben vorher speichern.' })
        .then(r => { if (r.response === 0) au.quitAndInstall(); });
    });
  }
  const p = au.checkForUpdates();
  if (manuell && p) p.then(r => { if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) dialog.showMessageBox(win, { message: 'Ihr habt die neuste Version (' + app.getVersion() + ').' }); })
    .catch(e => dialog.showMessageBox(win, { type: 'warning', message: 'Update-Prüfung nicht möglich.', detail: String(e && e.message || e) }));
  else if (p) p.catch(() => {});
}

/* ---------- Start ---------- */
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock', 'fileSystem'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['media', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'fileSystem'].includes(perm));
  menue();
  const r = await rootBestimmen(false);
  if (!r) { app.quit(); return; }
  fenster();
  setTimeout(() => updates(false), 8000);
  setInterval(() => updates(false), 6 * 3600 * 1000);
});
app.on('window-all-closed', () => app.quit());
