/* Segelmacherei Werkzeuge – Zendesk-Zwischenschritt (Cloudflare Worker)
   Zendesk erlaubt den Tausch "Code → Zugriffsschlüssel" nicht direkt aus dem Browser (kein CORS).
   Dieser Worker macht nur das: Er nimmt Code + PKCE-Prüfwert entgegen und holt bei Zendesk den Schlüssel
   (/token) bzw. erneuert ihn mit dem refresh_token (/refresh), damit man sich nicht ständig neu anmelden muss.
   Optional leitet er die zwei Lese-Abfragen der Kunden-Übersicht weiter (falls Zendesk sie im Browser blockiert).
   Er speichert nichts und kennt keine Passwörter. Erlaubt sind nur die Werkzeuge (github.io, lokale Datei, Windows-Programm). */
const ZD = 'https://segelmacherei.zendesk.com';
const CLIENT = 'segelmacherei_werkzeuge';
const REDIRECT = 'https://segelmacherei.github.io/werkzeuge-tablet/zendesk.html';
const ORIGINS = ['https://segelmacherei.github.io', 'null', 'file://']; // file:// = Windows-Programm
// Windows-Programm (Electron, file://) schickt gar keinen Origin mit → leer auch zulassen (der Worker kennt keine Geheimnisse)
const OK = o => o === '' || ORIGINS.includes(o) || /^file:/.test(o);
const API_OK = [/^\/api\/v2\/users\/search\.json$/, /^\/api\/v2\/users\/\d+\/tickets\/requested\.json$/, /^\/api\/v2\/users\/me\.json$/, /^\/api\/v2\/organizations\/\d+\/tickets\.json$/, /^\/api\/v2\/search\.json$/, /^\/api\/v2\/tickets\.json$/, /^\/api\/v2\/users\/show_many\.json$/];

function cors(origin) {
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (origin && OK(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (!OK(origin)) return json({ error: 'forbidden' }, 403, origin);

    if (url.pathname === '/token' && req.method === 'POST') {
      let b = {};
      try { b = await req.json(); } catch (e) {}
      if (!b.code || !b.code_verifier) return json({ error: 'invalid_request' }, 400, origin);
      const r = await fetch(ZD + '/oauth/tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code: String(b.code), client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: String(b.code_verifier), scope: 'tickets:read users:read' })
      });
      const t = await r.text();
      return new Response(t, { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    }

    // Zugriffsschlüssel erneuern: { refresh_token } → Zendesk grant_type=refresh_token (öffentlicher Client, ohne Geheimnis)
    if (url.pathname === '/refresh' && req.method === 'POST') {
      let b = {};
      try { b = await req.json(); } catch (e) {}
      if (!b.refresh_token || typeof b.refresh_token !== 'string' || b.refresh_token.length > 4000) return json({ error: 'invalid_request' }, 400, origin);
      const r = await fetch(ZD + '/oauth/tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: b.refresh_token, client_id: CLIENT, scope: 'tickets:read users:read' })
      });
      const t = await r.text();
      return new Response(t, { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    }

    if (req.method === 'GET' && API_OK.some(rx => rx.test(url.pathname))) {
      const auth = req.headers.get('Authorization') || '';
      if (!/^Bearer [\w.-]+$/.test(auth)) return json({ error: 'unauthorized' }, 401, origin);
      const r = await fetch(ZD + url.pathname + url.search, { headers: { Authorization: auth, Accept: 'application/json' } });
      const t = await r.text();
      return new Response(t, { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
    }
    return json({ error: 'not_found' }, 404, origin);
  }
};
