/* Segelmacherei Werkzeuge (Windows) – Dateizugriff ohne Electron, damit er einzeln testbar ist.
 * Die Werkzeuge sehen den Nextcloud-Ordner „04-Vertrieb“ immer als /04-Vertrieb (wie in der Tablet-App).
 * Ordner ausserhalb (z.B. auf dem Desktop) gehen nur, wenn sie im Dialog gewählt wurden → /@/C:/…
 */
'use strict';
const path = require('path'), fs = require('fs'), fsp = fs.promises, os = require('os');
const VROOT = '/04-Vertrieb';
const WERKZEUGE = ['04 Werkzeuge', 'Werkzeuge.html'];
// Interne Dateien des Nextcloud-Clients und von Windows nicht anzeigen
const VERSTECKT = /^(desktop\.ini|thumbs\.db|\.sync_[^/]*|\._sync_[^/]*|\.owncloudsync\.log.*|\.nextcloudsync\.log.*|\.~lock\..*|~\$.*|\..*\.tmp~)$/i;

const fehler = (name, msg) => Object.assign(new Error(msg), { name });
const norm = p => '/' + String(p || '').split(/[\\/]+/).filter(x => x && x !== '.').join('/');

/* Nextcloud-Ordner finden: gespeicherter Pfad, sonst %USERPROFILE%\Nextcloud*\04-Vertrieb */
function istRoot(r) { try { return !!r && fs.statSync(path.join(r, ...WERKZEUGE)).isFile(); } catch (e) { return false; } }
function findeRoot(gespeichert, home) {
  home = home || os.homedir();
  const kand = [];
  if (process.env.SEG_ROOT) kand.push(process.env.SEG_ROOT);
  if (gespeichert) kand.push(gespeichert);
  let dirs = [];
  try { dirs = fs.readdirSync(home, { withFileTypes: true }).filter(d => d.isDirectory() && /nextcloud/i.test(d.name)).map(d => d.name); } catch (e) {}
  dirs.sort((a, b) => (a.toLowerCase() === 'nextcloud' ? -1 : 0) - (b.toLowerCase() === 'nextcloud' ? -1 : 0));
  for (const d of dirs) { kand.push(path.join(home, d, '04-Vertrieb')); kand.push(path.join(home, d, 'Segelmacherei', '04-Vertrieb')); }
  return kand.find(istRoot) || null;
}
/* Gewählten Ordner prüfen: 04-Vertrieb selbst, „04 Werkzeuge“ darin oder der Nextcloud-Ordner darüber */
function rootAusWahl(p) {
  if (!p) return null;
  for (const k of [p, path.dirname(p), path.join(p, '04-Vertrieb')]) if (istRoot(k)) return k;
  return null;
}

function erstelle(root, opt = {}) {
  const extra = new Set((opt.extra || []).map(x => path.resolve(x)));
  const papierkorb = opt.papierkorb || (p => fsp.rm(p, { recursive: true, force: true }));
  const innerhalb = (basis, p) => { const r = path.relative(basis, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

  function toReal(v) {
    v = norm(v);
    const teile = v.split('/').filter(Boolean);
    if (teile.includes('..')) throw fehler('SecurityError', 'Ungültiger Pfad');
    if (v === VROOT || v.startsWith(VROOT + '/')) return path.join(root, ...teile.slice(1));
    if (teile[0] === '@') {
      let s = teile.slice(1).join('/');
      if (!/^[A-Za-z]:/.test(s)) s = '/' + s; else if (/^[A-Za-z]:$/.test(s)) s += '/';
      const abs = path.resolve(s);
      for (const e of extra) if (innerhalb(e, abs)) return abs;
      if (innerhalb(root, abs)) return abs;
      throw fehler('SecurityError', 'Dieser Ordner wurde nicht freigegeben: ' + abs);
    }
    throw fehler('NotFoundError', 'Pfad ausserhalb der Werkzeuge: ' + v);
  }
  function toVirt(real) {
    real = path.resolve(real);
    if (innerhalb(root, real)) { const r = path.relative(root, real); return VROOT + (r ? '/' + r.split(path.sep).join('/') : ''); }
    return '/@/' + real.split(path.sep).filter(Boolean).join('/').replace(/^\/+/, '');
  }
  const eintrag = async (dirV, dirReal, name) => {
    try { const st = await fsp.stat(path.join(dirReal, name)); return { name, path: norm(dirV + '/' + name), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }; }
    catch (e) { return null; }
  };
  return {
    root, VROOT, toReal, toVirt,
    erlaube(real) { extra.add(path.resolve(real)); },
    extraListe() { return [...extra]; },
    async list(v) {
      const real = toReal(v);
      let d;
      try { d = await fsp.readdir(real); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
      const out = await Promise.all(d.filter(n => !VERSTECKT.test(n)).map(n => eintrag(norm(v), real, n)));
      return out.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    },
    async stat(v) {
      v = norm(v);
      try { const st = await fsp.stat(toReal(v)); return { name: v.split('/').pop() || '', path: v, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }; }
      catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
    },
    async read(v) {
      const real = toReal(v);
      try { const [b, st] = await Promise.all([fsp.readFile(real), fsp.stat(real)]); return { bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), mtime: st.mtimeMs }; }
      catch (e) { if (e.code === 'ENOENT') throw fehler('NotFoundError', 'Datei nicht gefunden: ' + norm(v)); if (e.code === 'EISDIR') throw fehler('TypeMismatchError', 'Ist ein Ordner: ' + norm(v)); throw e; }
    },
    async write(v, bytes) {
      const real = toReal(v), dir = path.dirname(real);
      await fsp.mkdir(dir, { recursive: true });
      const data = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0));
      // Zuerst in eine Hilfsdatei schreiben (Nextcloud ignoriert Namen mit ~ am Ende), dann umbenennen → nie halbe Dateien
      const tmp = path.join(dir, '.' + path.basename(real) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp~');
      try { await fsp.writeFile(tmp, data); await fsp.rename(tmp, real); }
      catch (e) {
        try { await fsp.unlink(tmp); } catch (e2) {}
        if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') { await fsp.writeFile(real, data); return true; } // Datei gerade geöffnet (z.B. Nextcloud) → direkt schreiben
        throw e;
      }
      return true;
    },
    async mkdir(v) { await fsp.mkdir(toReal(v), { recursive: true }); return true; },
    async remove(v) {
      const real = toReal(v);
      if (real === root) throw fehler('SecurityError', 'Der Hauptordner kann nicht gelöscht werden');
      try { await fsp.stat(real); } catch (e) { throw fehler('NotFoundError', 'Nicht gefunden: ' + norm(v)); }
      await papierkorb(real); return true;
    },
    /* Ordner verschieben (nur innerhalb 04-Vertrieb, nie überschreiben) – z.B. von „01 Offeriert“ zu den Aufträgen */
    async move(v, zielOrdnerV) {
      const real = toReal(v), zielDir = toReal(zielOrdnerV), ziel = path.join(zielDir, path.basename(real));
      if (real === root || !innerhalb(root, real) || !innerhalb(root, zielDir)) throw fehler('SecurityError', 'Nur innerhalb von 04-Vertrieb');
      try { await fsp.stat(real); } catch (e) { throw fehler('NotFoundError', 'Nicht gefunden: ' + norm(v)); }
      if (fs.existsSync(ziel)) throw fehler('InvalidModificationError', 'Am Ziel gibt es schon: ' + path.basename(real));
      try { await fsp.rename(real, ziel); }
      catch (e) { if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') throw fehler('NoModificationAllowedError', 'Eine Datei im Ordner ist gerade geöffnet. Bitte schliessen und nochmals versuchen.'); throw e; }
      return toVirt(ziel);
    }
  };
}

module.exports = { VROOT, norm, istRoot, findeRoot, rootAusWahl, erstelle, fehler };
