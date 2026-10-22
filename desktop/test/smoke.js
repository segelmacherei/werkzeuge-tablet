/* Rauchtest für das gebaute Windows-Programm (läuft in GitHub Actions auf Windows).
 * Prüft: Programm startet, findet den Ordner (SEG_ROOT), Ordnerzugriff ohne Nachfrage (auch im Rahmen),
 * Schreiben/Lesen, Link segelmacherei://kunde?id=42 → #kunde?id=42, zweiter Link geht ins offene Fenster. */
'use strict';
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segtest-'));
  const root = path.join(tmp, 'Nextcloud', '04-Vertrieb'), wz = path.join(root, '04 Werkzeuge');
  fs.mkdirSync(path.join(root, '500147 Testkunde AG'), { recursive: true });
  fs.mkdirSync(wz, { recursive: true });
  fs.writeFileSync(path.join(root, '500147 Testkunde AG', 'alt.txt'), 'vorhanden');
  const probe = `<script>
  window.addEventListener('load', async () => {
    const out = [];
    try {
      out.push('seg=' + !!window.__segDesktop);
      const h = await window.showDirectoryPicker({ id: 'vertrieb', mode: 'readwrite' });
      out.push('perm=' + await h.queryPermission({ mode: 'readwrite' }));
      const p = await h.getDirectoryHandle('500147 Testkunde AG');
      const names = []; for await (const [n] of p.entries()) names.push(n); out.push('list=' + names.join(','));
      const f = await p.getFileHandle('neu.txt', { create: true }); const w = await f.createWritable(); await w.write('Grüezi'); await w.close();
      out.push('read=' + await (await (await p.getFileHandle('neu.txt')).getFile()).text());
      const off = await h.getDirectoryHandle('01 Offeriert', { create: true }), q = await off.getDirectoryHandle('2600999 Verschiebetest', { create: true });
      await q.move(h); out.push('move=' + ((await h.getDirectoryHandle('2600999 Verschiebetest')).kind));
      const db = await new Promise(r => { const q = indexedDB.open('werkzeuge', 1); q.onupgradeneeded = () => q.result.createObjectStore('h'); q.onsuccess = () => r(q.result); });
      const v = await new Promise(r => { const q = db.transaction('h').objectStore('h').get('vertrieb'); q.onsuccess = () => r(q.result); });
      out.push('idb=' + (v && v.path));
    } catch (e) { out.push('FEHLER ' + e.name + ': ' + e.message); }
    document.getElementById('o').textContent = out.join(' | ');
  });
  window.addEventListener('hashchange', () => { document.getElementById('h').textContent = location.hash; });
  </script>`;
  fs.writeFileSync(path.join(wz, 'Werkzeuge.html'), `<!doctype html><meta charset="utf-8"><title>Test</title><body><div id="o">…</div><div id="h"></div><div id="h0"></div>
    <iframe id="f" src="Offerte%20und%20Montage/rahmen.html"></iframe>${probe}<script>document.getElementById('h0').textContent='start '+location.hash</script></body>`);
  fs.mkdirSync(path.join(wz, 'Offerte und Montage'), { recursive: true });
  fs.writeFileSync(path.join(wz, 'Offerte und Montage', 'rahmen.html'), `<!doctype html><meta charset="utf-8"><body><div id="r">…</div><script>
    (async()=>{try{const h=await window.showDirectoryPicker({id:'vertrieb'});const n=[];for await(const [x] of h.entries())n.push(x);document.getElementById('r').textContent='rahmen='+n.join(',')}catch(e){document.getElementById('r').textContent='rahmen FEHLER '+e.message}})()</script></body>`);

  const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', 'Segelmacherei Werkzeuge.exe');
  const app = await electron.launch({ executablePath: exe, args: ['segelmacherei://kunde?id=42'], env: { ...process.env, SEG_ROOT: root } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => document.getElementById('o') && document.getElementById('o').textContent !== '…', null, { timeout: 30000 });
  await win.waitForTimeout(1500);
  const o = await win.textContent('#o'), h0 = await win.textContent('#h0');
  const rahmen = await win.frameLocator('#f').locator('#r').textContent();
  await win.screenshot({ path: path.join(__dirname, 'smoke.png') });
  const datei = fs.existsSync(path.join(root, '500147 Testkunde AG', 'neu.txt')) ? fs.readFileSync(path.join(root, '500147 Testkunde AG', 'neu.txt'), 'utf8') : null;
  const reste = fs.readdirSync(path.join(root, '500147 Testkunde AG')).filter(n => n.endsWith('~'));
  console.log({ o, h0, rahmen, datei, reste });
  const ok = /seg=true/.test(o) && /perm=granted/.test(o) && /list=alt\.txt/.test(o) && /read=Grüezi/.test(o) && /idb=\/04-Vertrieb/.test(o) && /move=directory/.test(o)
    && /kunde\?id=42/.test(h0) && /rahmen=.*500147 Testkunde AG/.test(rahmen) && datei === 'Grüezi' && !reste.length;
  // prompt(): eigenes Eingabefenster
  await win.evaluate(() => { setTimeout(() => { window.__p = prompt('Abstand in mm?', '4200'); }, 50); });
  let pw = null; for (let i = 0; i < 40 && !pw; i++) { await win.waitForTimeout(250).catch(() => {}); pw = app.windows().find(w => w !== win); }
  let pr = 'kein Fenster';
  if (pw) { await pw.waitForSelector('#i'); await pw.fill('#i', '5100'); await pw.press('#i', 'Enter').catch(() => {}); await new Promise(r => setTimeout(r, 800)); pr = await win.evaluate(() => window.__p); }
  console.log({ prompt: pr });
  const okPrompt = pr === '5100';
  await app.close();
  if (!okPrompt) { console.error('PROMPT FEHLGESCHLAGEN'); process.exit(1); }
  if (!ok) { console.error('RAUCHTEST FEHLGESCHLAGEN'); process.exit(1); }
  console.log('RAUCHTEST OK');
})().catch(e => { console.error(e); process.exit(1); });
