// download.ephix.net — a gated search bar in front of Sonarr and Radarr.
//
// Request flow
//   browser -> Cloudflare Access (one-time PIN) -> this Worker
//     -> https://sonarr-api.ephix.net / radarr-api.ephix.net (Cloudflare Tunnel, same Access app)
//     -> Sonarr :8989 / Radarr :7878 on the laptop at home
//
// The Worker verifies the Access JWT itself (not just trusting that Access sits in
// front), and forwards that JWT to the origin hostnames so the tunnel side is gated
// by the same login. Sonarr/Radarr API keys live in Worker secrets.

const ROOT_TV = 'C:\\Users\\lewih\\Downloads\\Media\\TV';
const ROOT_MOVIES = 'C:\\Users\\lewih\\Downloads\\Media\\Movies';
const QUALITY = 'HD-1080p';

// Sites allowed to call the API from the browser (the ⬇ icons on Ephix Pulse cards).
// Same registrable domain as download.ephix.net, so the Access cookie travels with the
// request; CORS is still needed because the origin differs. Access itself is configured
// to let OPTIONS preflights through to us.
const CORS_ORIGINS = new Set(['https://ephix.net', 'https://www.ephix.net']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = CORS_ORIGINS.has(origin) ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    } : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Hard gate: refuse everything until Access is configured and the JWT checks out.
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAILS) {
      return text('Not configured: ACCESS_TEAM_DOMAIN / ACCESS_AUD / ALLOWED_EMAILS are unset.', 503);
    }
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    const who = jwt ? await verifyAccessJwt(jwt, env) : null;
    if (!who) return text('Forbidden', 403, cors);
    // Being signed in to the right Zero Trust org is not the same as being the right
    // person: the Access policy could include others, now or later.
    if (!allowedEmails(env).has(String(who.email || '').toLowerCase())) {
      console.log(`rejected ${who.email || '(no email in JWT)'}: not on ALLOWED_EMAILS`);
      return text(`Forbidden: ${who.email || 'that identity'} is not on the allow list.`, 403, cors);
    }

    try {
      if (url.pathname === '/') return html(PAGE(who.email, url.searchParams.get('add') || ''));
      if (url.pathname === '/api/me') return json({ email: who.email }, 200, cors);
      if (url.pathname === '/api/seasons') return json(await seasons({ id: url.searchParams.get('tvdbId'), tmdbId: url.searchParams.get('tmdbId') }, env, jwt), 200, cors);
      if (url.pathname === '/api/search') return json(await search(url.searchParams.get('q') || '', env, jwt), 200, cors);
      if (url.pathname === '/api/add' && request.method === 'POST') return json(await addOrQueue(await request.json(), env, jwt), 200, cors);
      if (url.pathname === '/api/raw') return json(await rawSearch(url.searchParams.get('q') || '', env, jwt), 200, cors);
      if (url.pathname === '/api/grab' && request.method === 'POST') return json(await addOrQueue({ type: 'raw', ...(await request.json()) }, env, jwt), 200, cors);
      if (url.pathname === '/api/queue') return json(await queueOrOffline(env, jwt), 200, cors);
      if (url.pathname === '/api/history') return json(await historyOrOffline(env, jwt), 200, cors);
      if (url.pathname === '/api/pending') return json({ pending: await listPending(env) }, 200, cors);
      if (url.pathname === '/shows') return html(SUBS_PAGE(who.email));
      if (url.pathname === '/api/subs') return json(await subs(env, jwt), 200, cors);
      if (url.pathname === '/api/sub' && request.method === 'POST') return json(await subAction(await request.json(), env, jwt), 200, cors);
      return text('Not found', 404, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
  },

  // Every 5 minutes: retry anything that was requested while home was offline, and say
  // in the logs whether the origin is reachable at all.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainPending(env));
    ctx.waitUntil(probeOrigin(env));
  },
};

// ---------- offline queue (KV) ----------
//
// The tunnel is only up while the laptop is on and online. An Add that fails for
// that reason is stored in KV and retried by the cron until Sonarr/Radarr accept it.
// Retries reuse the visitor's Access JWT from request time (valid 24h, which covers
// most outages) unless a service token is configured, which never expires.

async function addOrQueue(req, env, jwt) {
  try {
    return await add(req, env, jwt);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await env.QUEUE.put(`pending:${id}`, JSON.stringify({ ...req, at: new Date().toISOString(), jwt }), { expirationTtl: 7 * 86400 });
    return { ok: true, queued: true, title: req.title || '', id };
  }
}

async function listPending(env) {
  const { keys } = await env.QUEUE.list({ prefix: 'pending:' });
  const items = await Promise.all(keys.map(async (k) => {
    const v = await env.QUEUE.get(k.name, 'json');
    return v && { id: k.name.slice(8), type: v.type, title: v.title || (v.type === 'raw' ? v.guid : ''), year: v.year || '', mode: v.mode, at: v.at, tries: v.tries || 0, lastError: v.lastError || '' };
  }));
  return items.filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
}

async function drainPending(env) {
  const { keys } = await env.QUEUE.list({ prefix: 'pending:' });
  for (const k of keys) {
    const v = await env.QUEUE.get(k.name, 'json');
    if (!v) continue;
    try {
      await add(v, env, v.jwt);
      await env.QUEUE.delete(k.name);
    } catch (e) {
      v.tries = (v.tries || 0) + 1;
      v.lastError = String(e.message || e).slice(0, 200);
      await env.QUEUE.put(k.name, JSON.stringify(v), { expirationTtl: 7 * 86400 });
    }
  }
}

// A health check the cron can run on its own. Every other path needs a visitor to be
// signed in, which makes "is the origin reachable" impossible to answer without someone
// loading the page. Cron runs outside Access, so this reports the raw truth: which
// credential the Worker chose, and exactly what Access said back.
async function probeOrigin(env) {
  const via = env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET ? 'service token' : 'forwarded JWT (will fail)';
  try {
    const r = await fetch(`${env.SONARR_URL}/api/v3/system/status`, {
      redirect: 'manual',
      headers: originHeaders(env, '', env.SONARR_API_KEY),
    });
    const where = r.status >= 300 && r.status < 400 ? ` -> ${(r.headers.get('location') || 'no location').slice(0, 140)}` : '';
    const body = r.status >= 400 && r.status < 500 ? ` body=${(await r.text()).slice(0, 160)}` : '';
    console.log(`probe sonarr via ${via}: ${r.status}${where}${body}`);
  } catch (e) {
    console.log(`probe sonarr via ${via}: threw ${e.message || e}`);
  }
}

async function queueOrOffline(env, jwt) {
  try {
    return await queue(env, jwt);
  } catch (e) {
    if (isOffline(e)) return { items: [], offline: true };
    throw e;
  }
}

// ---------- Access JWT ----------

// Access decides who may reach the Worker; this decides who it will actually work for.
// Worth having both: the same Access application also fronts the sonarr/radarr/qbit
// hostnames directly, so if that policy is ever widened, this still holds the API
// itself to the addresses named in ALLOWED_EMAILS.
const allowedEmails = (env) => new Set(
  String(env.ALLOWED_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
);

let certCache = { keys: null, at: 0 };

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlToStr(h));
  const payload = JSON.parse(b64urlToStr(p));

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!payload.exp || payload.exp < now) return null;

  if (!certCache.keys || Date.now() - certCache.at > 3600_000) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    certCache = { keys: (await r.json()).keys, at: Date.now() };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return ok ? payload : null;
}

function b64urlToBytes(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64urlToStr(str) {
  return new TextDecoder().decode(b64urlToBytes(str));
}

// ---------- Sonarr / Radarr ----------

function originHeaders(env, jwt, apiKey, extra = {}) {
  const h = { 'X-Api-Key': apiKey, Accept: 'application/json', ...extra };
  // Same Access application as this Worker, so the visitor's JWT is valid there too.
  if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
    h['CF-Access-Client-Id'] = env.ACCESS_CLIENT_ID;
    h['CF-Access-Client-Secret'] = env.ACCESS_CLIENT_SECRET;
  } else {
    h['Cf-Access-Jwt-Assertion'] = jwt;
  }
  return h;
}

// "Home is offline" is decided by how the call to the tunnel fails, not by matching
// error text: the fetch itself throwing (no route), any 5xx (Cloudflare's 5xx/52x/530
// when the tunnel has no connector, or Sonarr/Radarr mid-restart), or Access bouncing us
// to its login page (the forwarded JWT was refused — nothing behind it can be reached).
class OfflineError extends Error { constructor(m) { super(m); this.offline = true; } }
const isOffline = (e) => !!e?.offline;

const APPS = {
  sonarr:   { url: 'SONARR_URL',   key: 'SONARR_API_KEY',   api: '/api/v3' },
  radarr:   { url: 'RADARR_URL',   key: 'RADARR_API_KEY',   api: '/api/v3' },
  prowlarr: { url: 'PROWLARR_URL', key: 'PROWLARR_API_KEY', api: '/api/v1' },
};

async function arr(app, path, env, jwt, init = {}) {
  const base = env[APPS[app].url];
  const key = env[APPS[app].key];
  let r;
  try {
    r = await fetch(`${base}${APPS[app].api}${path}`, {
      ...init,
      redirect: 'manual',
      headers: originHeaders(env, jwt, key, init.body ? { 'Content-Type': 'application/json' } : {}),
    });
  } catch (e) {
    throw new OfflineError(`${app} unreachable: ${e.message || e}`);
  }
  const body = await r.text();
  if (r.status >= 500) throw new OfflineError(`${app} ${r.status}: ${body.slice(0, 200)}`);
  if (r.status >= 300 && r.status < 400) throw new OfflineError(`${app} ${r.status}: redirected to ${r.headers.get('location') || 'login'}`);
  if (!r.ok) throw new Error(`${app} ${r.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

const poster = (images) => (images || []).find((i) => i.coverType === 'poster')?.remoteUrl || '';

// ---------- TMDB fallback (via the public proxy on ephix.net) ----------
// Used when home is offline, so search and the season picker keep working and an add can
// be queued with a TMDB id. Sonarr/Radarr resolve TMDB ids themselves once they're back.
const TMDB_PROXY = 'https://ephix.net/api/tmdb';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w185';

async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ path, ...params }).toString();
  const r = await fetch(`${TMDB_PROXY}?${qs}`, { cf: { cacheTtl: 600 } });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

// ---------- relevance ranking ----------
// TVDB and TMDB each return their own fuzzy list; concatenating them put every TV hit above
// every film, so a film sequel ("Super Troopers 3") sat under eight unrelated shows. Score
// each result against the query and merge: exact title > starts with > all words present >
// most words present; a number in the query ("3") must appear in the title to count as a
// strong match. Ties keep the source order (which is roughly popularity).
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function relevance(title, q) {
  const t = norm(title), n = norm(q);
  if (!t || !n) return 0;
  if (t === n) return 100;
  const qw = n.split(' '), tw = new Set(t.split(' '));
  const hit = qw.filter((w) => tw.has(w)).length;
  const nums = qw.filter((w) => /^\d+$/.test(w));
  const numOk = nums.every((w) => tw.has(w));
  if (t.startsWith(n)) return 90;
  if (hit === qw.length) return 80;
  if (numOk && hit >= qw.length - nums.length) return 70;   // all words but a stray number
  return Math.round((hit / qw.length) * 50) - (nums.length && !numOk ? 10 : 0);
}
function rank(results, name, rawQuery) {
  // votes (TVDB/TMDB) break ties between same-titled results: Die Hard (1988) over a 2024 show
  return results
    .map((r, i) => ({ r, i, s: relevance(r.title, name) + (r.year && String(rawQuery).includes(String(r.year)) ? 15 : 0) + Math.min(9, Math.log10((r.votes || 0) + 1) * 2) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
    .slice(0, 12);
}

async function searchTmdb(name, rawQuery = name) {
  const d = await tmdb('search/multi', { query: name, include_adult: 'false' });
  const results = (d.results || [])
    .filter((x) => x.media_type === 'tv' || x.media_type === 'movie')
    .slice(0, 12)
    .map((x) => ({
      type: x.media_type, id: null, tmdbId: x.id,
      title: x.title || x.name || '', year: Number((x.release_date || x.first_air_date || '').slice(0, 4)) || '',
      network: '', status: '', overview: x.overview || '', poster: x.poster_path ? TMDB_IMG + x.poster_path : '',
      inLibrary: null, // unknown while home is offline
      votes: x.vote_count || 0,
    }));
  return { results: rank(results, name, rawQuery), offline: true };
}

async function seasonsTmdb(tmdbId) {
  const d = await tmdb(`tv/${tmdbId}`);
  const list = (d.seasons || []).map((s) => s.season_number).filter((n) => n > 0).sort((a, b) => a - b);
  return { title: d.name, year: Number((d.first_air_date || '').slice(0, 4)) || '', tmdbId: d.id, inLibrary: null, status: d.status || '', seasons: list, offline: true };
}

async function search(q, env, jwt) {
  q = q.trim();
  if (!q) return { results: [] };
  // Strip an SxxEyy or year so the metadata lookup sees just the name.
  const name = q.replace(/\bS\d{1,2}E\d{1,3}\b/i, '').replace(/\b(19|20)\d{2}\b/, '').trim() || q;
  const term = encodeURIComponent(name);
  let shows, films;
  try {
    [shows, films] = await Promise.all([
      arr('sonarr', `/series/lookup?term=${term}`, env, jwt),
      arr('radarr', `/movie/lookup?term=${term}`, env, jwt),
    ]);
  } catch (e) {
    if (isOffline(e)) return searchTmdb(name, q);
    throw e;
  }
  // Lookup results for shows already in the library carry an id but no statistics.
  const top = shows.slice(0, 8);
  const files = await Promise.all(top.map((s) => (s.id
    ? arr('sonarr', `/series/${s.id}`, env, jwt).then((f) => f.statistics?.episodeFileCount ?? null).catch(() => null)
    : null)));
  const results = [
    ...top.map((s, i) => ({
      type: 'tv', id: s.tvdbId, title: s.title, year: s.year, network: s.network || '',
      status: s.status, overview: s.overview || '', poster: poster(s.images),
      inLibrary: !!s.id, files: files[i], votes: s.ratings?.votes || 0,
    })),
    ...films.slice(0, 8).map((m) => ({
      type: 'movie', id: m.tmdbId, title: m.title, year: m.year, network: m.studio || '',
      status: m.status, overview: m.overview || '', poster: poster(m.images),
      inLibrary: !!m.id, hasFile: !!m.hasFile, votes: m.ratings?.tmdb?.votes || m.ratings?.imdb?.votes || 0,
    })),
  ];
  return { results: rank(results, name, q) };
}

async function profileId(app, env, jwt) {
  const profiles = await arr(app, '/qualityprofile', env, jwt);
  return (profiles.find((p) => p.name === QUALITY) || profiles[0]).id;
}

// Windows device names are legal in a title but not usable as a folder.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// A folder name safe to append to a root. Beyond the characters Windows forbids, this
// drops control characters and trailing dots/spaces. Windows silently strips those, so
// the path you asked for isn't the one you get, and stripping them here also reduces
// ".." to nothing rather than a step up out of the root folder. Never returns an empty
// string: an empty one would hand Sonarr/Radarr the library root as the item's path.
const safeFolder = (s, fallback = 'Unknown') => {
  const out = String(s ?? '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  return !out || RESERVED.test(out) ? fallback : out;
};

const tvTerm = ({ id, tmdbId }) => (tmdbId ? `tmdb:${tmdbId}` : `tvdb:${id}`);

// What seasons a show has, so the UIs can offer a picker before adding.
async function seasons(q, env, jwt) {
  let s;
  try {
    [s] = await arr('sonarr', `/series/lookup?term=${tvTerm(q)}`, env, jwt);
  } catch (e) {
    if (isOffline(e) && q.tmdbId) return seasonsTmdb(q.tmdbId);
    throw e;
  }
  if (!s) throw new Error('Not found on TVDB');
  const list = (s.seasons || []).map((x) => x.seasonNumber).filter((n) => n > 0).sort((a, b) => a - b);
  return { title: s.title, year: s.year, tvdbId: s.tvdbId, inLibrary: !!s.id, status: s.status, seasons: list };
}

// `id` is a TVDB id for tv and a TMDB id for movies (what the search page sends);
// `tmdbId` is accepted for either type (what Ephix Pulse cards have).
// TV `mode`: 'all' | 'future' | 'latest' | 'seasons' (with `seasons: [n, …]`).
// Every mode keeps future episodes monitored, so a show keeps coming after the pick.
async function add({ type, id, mode, tmdbId, seasons: picked, guid, indexerId, title, q }, env, jwt) {
  if (type === 'raw') return grab({ guid, indexerId, title, q }, env, jwt);
  if (type === 'tv') {
    const [s] = await arr('sonarr', `/series/lookup?term=${tvTerm({ id, tmdbId })}`, env, jwt);
    if (!s) throw new Error('Not found on TVDB');
    if (s.id) return { ok: true, already: true, title: s.title };
    const folder = safeFolder(s.title.replace(/\s*\(\d{4}\)$/, ''), `Series ${s.tvdbId}`);
    let monitor = 'all';
    let seasonList = s.seasons;
    if (mode === 'future') monitor = 'future';
    if (mode === 'latest' || mode === 'seasons') {
      const nums = (s.seasons || []).map((x) => x.seasonNumber).filter((n) => n > 0);
      const want = new Set(mode === 'latest' ? [Math.max(...nums)] : (picked || []).map(Number));
      if (!want.size) throw new Error('No seasons chosen');
      monitor = 'skip'; // keep the per-season flags below exactly as sent
      seasonList = (s.seasons || []).map((x) => ({ ...x, monitored: want.has(x.seasonNumber) }));
    }
    const r = await arr('sonarr', '/series', env, jwt, {
      method: 'POST',
      body: JSON.stringify({
        tvdbId: s.tvdbId, title: s.title, titleSlug: s.titleSlug, images: s.images, seasons: seasonList,
        path: `${ROOT_TV}\\${folder}`, rootFolderPath: ROOT_TV,
        qualityProfileId: await profileId('sonarr', env, jwt),
        seasonFolder: true, monitored: true, seriesType: 'standard', monitorNewItems: 'all',
        addOptions: { monitor, searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false },
      }),
    });
    return { ok: true, title: r.title, year: r.year, monitor, seasons: mode === 'seasons' ? picked : undefined };
  }
  if (type === 'movie') {
    const [m] = await arr('radarr', `/movie/lookup?term=tmdb:${tmdbId || id}`, env, jwt);
    if (!m) throw new Error('Not found on TMDB');
    if (m.id) return { ok: true, already: true, title: m.title };
    const folder = safeFolder(`${m.title} (${m.year})`, `Movie ${m.tmdbId}`);
    const r = await arr('radarr', '/movie', env, jwt, {
      method: 'POST',
      body: JSON.stringify({
        tmdbId: m.tmdbId, title: m.title, year: m.year, titleSlug: m.titleSlug, images: m.images,
        path: `${ROOT_MOVIES}\\${folder}`, rootFolderPath: ROOT_MOVIES,
        qualityProfileId: await profileId('radarr', env, jwt),
        monitored: true, minimumAvailability: 'released',
        addOptions: { searchForMovie: true, monitor: 'movieOnly' },
      }),
    });
    return { ok: true, title: r.title, year: r.year };
  }
  throw new Error('type must be tv or movie');
}

// ---------- raw torrent search (Prowlarr → qBittorrent → Media\Other) ----------
// For things TVDB/TMDB don't know. Same fake-filter as Get-Torrent.ps1: executable-named
// releases and tiny files are dropped, then best-seeded first.
//
// \b rather than an end anchor so ".exe" still matches mid-name (".exe.torrent", "[.scr]")
// without swallowing innocent words: ".comedy" is not a ".com".
const BAD_NAME = /\.(exe|scr|msi|com|bat|cmd|ps1|vbs|js|jar|hta|pif|lnk|zipx|apk)\b/i;
const MIN_BYTES = 50 * 2 ** 20;

// The single place that decides whether a Prowlarr result may be fetched. Both the search
// view and the grab endpoint go through it, so the two cannot drift apart.
// Some indexers (TorrentsCSV) return a bare magnet guid with no download link; Prowlarr
// can't grab those, so they're dropped rather than shown with a button that does nothing.
const grabbable = (r) => r.protocol === 'torrent' && (r.downloadUrl || r.magnetUrl)
  && !BAD_NAME.test(r.title || '') && (r.size || 0) >= MIN_BYTES;

const prowlarrSearch = (q, env, jwt) =>
  arr('prowlarr', `/search?query=${encodeURIComponent(q)}&type=search&limit=150`, env, jwt);

async function rawSearch(q, env, jwt) {
  q = q.trim();
  if (!q) return { results: [] };
  const rows = await prowlarrSearch(q, env, jwt);
  const seen = new Set();
  const results = rows
    .filter(grabbable)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .filter((r) => !seen.has(r.title) && seen.add(r.title))
    .slice(0, 30)
    .map((r) => ({ guid: r.guid, indexerId: r.indexerId, indexer: r.indexer, title: r.title, gb: ((r.size || 0) / 2 ** 30).toFixed(2), seeders: r.seeders || 0, leechers: r.leechers || 0, age: (r.publishDate || '').slice(0, 10), info: r.infoUrl || '' }));
  const hidden = rows.filter((r) => r.protocol === 'torrent' && BAD_NAME.test(r.title || '')).length;
  return { results, hidden };
}

// The name filter is only a control if it is enforced here too: rawSearch decides what is
// *shown*, this decides what can actually be fetched. A hand-written POST can carry any
// guid, so don't take the client's word for what it picked. Re-run the same query on this
// side, find that guid among the results, and test the indexer's own title against the
// filter. `q` is what makes that possible, so it is required.
async function grab({ guid, indexerId, q, title }, env, jwt) {
  if (!guid || !indexerId) throw new Error('guid and indexerId required');
  // Newer pages send the search that produced this pick. Older cached pages send only the
  // release title, so fall back to searching for that. Either way the guid is confirmed
  // against what the indexer returns just now, so the client's claim is never trusted.
  const query = String(q ?? title ?? '').trim();
  if (!query) throw new Error('Nothing to verify this pick against. Reload the page and search again.');
  const rows = await prowlarrSearch(query, env, jwt);
  const match = rows.find((r) => r.guid === guid && Number(r.indexerId) === Number(indexerId));
  if (!match) throw new Error('That result has dropped out of the search. Search again and re-grab.');
  if (!grabbable(match)) throw new Error(`Refused "${match.title}": executable-style name, or under ${MIN_BYTES / 2 ** 20} MB.`);
  await arr('prowlarr', '/search', env, jwt, { method: 'POST', body: JSON.stringify({ guid, indexerId: Number(indexerId) }) });
  return { ok: true, title: match.title, raw: true };
}

// "Downloading now" comes straight from qBittorrent (everything it's working on, whoever
// added it — Sonarr, Radarr, a raw grab), with Sonarr/Radarr consulted only to put a proper
// episode/film name on each torrent. Falls back to the two arr queues if qBittorrent isn't
// published through the tunnel yet.
async function queue(env, jwt) {
  const [sq, rq, qb] = await Promise.all([
    arr('sonarr', '/queue?pageSize=50&includeEpisode=true&includeSeries=true', env, jwt).catch(() => ({ records: [] })),
    arr('radarr', '/queue?pageSize=50&includeMovie=true', env, jwt).catch(() => ({ records: [] })),
    env.QBIT_URL ? qbit('/torrents/info?filter=active', env, jwt).catch(() => null) : null,
  ]);
  const pct = (r) => (r.size ? Math.round(((r.size - r.sizeleft) / r.size) * 100) : 0);
  const named = new Map(); // downloadId (torrent hash, upper) -> friendly title
  for (const r of sq.records) if (r.downloadId) named.set(r.downloadId.toUpperCase(), r.series ? `${r.series.title} S${String(r.episode?.seasonNumber ?? 0).padStart(2, '0')}E${String(r.episode?.episodeNumber ?? 0).padStart(2, '0')}` : r.title);
  for (const r of rq.records) if (r.downloadId) named.set(r.downloadId.toUpperCase(), r.movie ? `${r.movie.title} (${r.movie.year})` : r.title);

  if (qb) {
    const fmtEta = (s) => (s >= 8640000 || s <= 0) ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(1, Math.round(s / 60))}m`;
    const state = (t) => ({ downloading: 'downloading', metaDL: 'fetching metadata', stalledDL: 'stalled — no peers', queuedDL: 'queued', pausedDL: 'paused', stoppedDL: 'stopped', checkingDL: 'checking', forcedDL: 'downloading', uploading: 'done', stalledUP: 'done', queuedUP: 'done', pausedUP: 'done', stoppedUP: 'done', forcedUP: 'done', error: 'error', missingFiles: 'missing files' })[t.state] || t.state;
    const items = qb
      .filter((t) => t.progress < 1 || Date.now() / 1000 - t.completion_on < 600) // hide long-finished ones
      .sort((a, b) => a.added_on - b.added_on)
      .map((t) => ({
        title: named.get(t.hash.toUpperCase()) || t.name, release: t.name,
        pct: Math.round(t.progress * 100), status: state(t), gb: (t.size / 2 ** 30).toFixed(2),
        eta: t.progress < 1 ? fmtEta(t.eta) : '', speed: t.dlspeed ? `${(t.dlspeed / 2 ** 20).toFixed(1)} MB/s` : '',
        via: t.category === 'tv-sonarr' ? 'TV' : t.category === 'movies-radarr' ? 'Film' : t.category === 'other' ? 'Other' : (t.category || ''),
      }));
    return { items, source: 'qbittorrent' };
  }
  return {
    items: [
      ...sq.records.map((r) => ({ title: named.get((r.downloadId || '').toUpperCase()) || r.title, release: r.title, pct: pct(r), status: r.trackedDownloadState || r.status, gb: (r.size / 2 ** 30).toFixed(2), eta: r.timeleft || '', via: 'TV' })),
      ...rq.records.map((r) => ({ title: named.get((r.downloadId || '').toUpperCase()) || r.title, release: r.title, pct: pct(r), status: r.trackedDownloadState || r.status, gb: (r.size / 2 ** 30).toFixed(2), eta: r.timeleft || '', via: 'Film' })),
    ],
    source: 'arr',
  };
}

// qBittorrent Web API through the tunnel. It trusts localhost (which is what the tunnel
// looks like to it), so Access is the only gate — same as the arr apps.
async function qbit(path, env, jwt) {
  let r;
  try {
    r = await fetch(`${env.QBIT_URL}/api/v2${path}`, { redirect: 'manual', headers: originHeaders(env, jwt, '', { Referer: `${env.QBIT_URL}/` }) });
  } catch (e) {
    throw new OfflineError(`qbittorrent unreachable: ${e.message || e}`);
  }
  if (r.status >= 500) throw new OfflineError(`qbittorrent ${r.status}`);
  if (r.status >= 300 && r.status < 400) throw new OfflineError(`qbittorrent ${r.status}: redirected`);
  if (!r.ok) throw new Error(`qbittorrent ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- recently downloaded ----------
//
// What has actually landed, as opposed to what is still coming. Both apps record an
// import event; merged and sorted by time they answer "did that thing arrive?", which is
// the question a push notification prompts and nothing else on the site could answer.

async function history(env, jwt) {
  const [tv, film] = await Promise.all([
    arr('sonarr', '/history?pageSize=30&sortKey=date&sortDirection=descending&eventType=3&includeEpisode=true&includeSeries=true', env, jwt),
    arr('radarr', '/history?pageSize=30&sortKey=date&sortDirection=descending&eventType=3&includeMovie=true', env, jwt),
  ]);
  const pad = (n) => String(n ?? 0).padStart(2, '0');
  const gb = (n) => (Number(n || 0) / 2 ** 30).toFixed(2);
  const items = [
    ...(tv.records || []).map((r) => ({
      via: 'TV', at: r.date,
      title: r.series?.title || r.sourceTitle,
      sub: r.episode ? `S${pad(r.episode.seasonNumber)}E${pad(r.episode.episodeNumber)}${r.episode.title ? ' · ' + r.episode.title : ''}` : '',
      quality: r.quality?.quality?.name || '', gb: gb(r.data?.size),
    })),
    ...(film.records || []).map((r) => ({
      via: 'Film', at: r.date,
      title: r.movie ? `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ''}` : r.sourceTitle,
      sub: '', quality: r.quality?.quality?.name || '', gb: gb(r.data?.size),
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 25);
  return { items };
}

// Same treatment as the queue: home being down is a normal state here, not an error.
async function historyOrOffline(env, jwt) {
  try {
    return await history(env, jwt);
  } catch (e) {
    if (isOffline(e)) return { items: [], offline: true };
    throw e;
  }
}

// ---------- subscriptions (/shows) ----------
//
// What the library is committed to, as opposed to what it already has: every series
// Sonarr tracks, plus every film Radarr is still waiting on. A film that already has
// its file is not a subscription, so it is left out.

// Soonest first, paused things last, so the top of the page is what actually moves next.
const byNext = (a, b) =>
  (b.monitored - a.monitored)
  || ((a.next ? 0 : 1) - (b.next ? 0 : 1))
  || String(a.next).localeCompare(String(b.next))
  || a.title.localeCompare(b.title);

async function subs(env, jwt) {
  const [series, movies] = await Promise.all([
    arr('sonarr', '/series', env, jwt),
    arr('radarr', '/movie', env, jwt),
  ]);
  const asTv = (s) => ({
    type: 'tv', id: s.id, title: s.title, year: s.year, status: s.status,
    monitored: s.monitored, poster: poster(s.images), by: s.network || '',
    next: s.nextAiring || '', have: s.statistics?.episodeFileCount ?? 0,
    total: s.statistics?.totalEpisodeCount ?? 0,
    seasons: (s.seasons || []).filter((x) => x.monitored && x.seasonNumber > 0).length,
  });
  const asFilm = (m) => ({
    type: 'movie', id: m.id, title: m.title, year: m.year, status: m.status,
    monitored: m.monitored, poster: poster(m.images), by: m.studio || '',
    next: m.digitalRelease || m.physicalRelease || m.inCinemas || '',
    have: 0, total: 1, seasons: 0, availability: m.minimumAvailability || '',
  });
  // A film with its file is finished, not a subscription. One without a file is either
  // waiting or paused, and both belong here: filtering paused ones out would make Pause
  // delete the row and leave no way to undo it.
  const all = [...series.map(asTv), ...movies.filter((m) => !m.hasFile).map(asFilm)];
  return {
    tv: all.filter((x) => x.type === 'tv' && x.monitored).sort(byNext),
    films: all.filter((x) => x.type === 'movie' && x.monitored).sort(byNext),
    paused: all.filter((x) => !x.monitored).sort(byNext),
  };
}

// Pause, Resume and Remove. Nothing here touches the disk: deleteFiles is pinned false,
// so the worst this page can do is make Sonarr/Radarr stop caring about something. A
// library entry is a click to rebuild; the files are not.
async function subAction({ type, id, action }, env, jwt) {
  if (!id) throw new Error('id required');
  if (type !== 'tv' && type !== 'movie') throw new Error('type must be tv or movie');
  const app = type === 'tv' ? 'sonarr' : 'radarr';
  const path = `${type === 'tv' ? '/series' : '/movie'}/${Number(id)}`;

  if (action === 'remove') {
    await arr(app, `${path}?deleteFiles=false&addImportListExclusion=false`, env, jwt, { method: 'DELETE' });
    return { ok: true, removed: true };
  }
  if (action === 'pause' || action === 'resume') {
    // Both apps want the whole object back on a PUT, so read it, flip the one field,
    // and send it as it came.
    const item = await arr(app, path, env, jwt);
    item.monitored = action === 'resume';
    await arr(app, path, env, jwt, { method: 'PUT', body: JSON.stringify(item) });
    return { ok: true, monitored: item.monitored };
  }
  throw new Error('action must be pause, resume or remove');
}

// ---------- responses ----------

const text = (s, status = 200, extra = {}) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...extra } });
const html = (s) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

// ---------- page ----------

// One stylesheet for every page the Worker serves, so /shows cannot drift away from /.
const STYLES = `
<style>
  :root {
    --surface: #fbfbf8; --panel: #ffffff; --ink: #17170f; --muted: #75756a;
    --hair: #e6e4da; --accent: #3538cd; --accent-ink: #ffffff; --good: #167a53; --chip: #f1f0e9; --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root { --surface: #14140f; --panel: #1d1d16; --ink: #f2f2ea; --muted: #9a9a8e;
            --hair: #35352c; --accent: #a0a3ff; --accent-ink: #14140f; --good: #4bbd8a; --chip: #26261f; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; background: var(--surface); color: var(--ink); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 16px 96px; }
  h1 { font-size: 22px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 4px; }
  .lede { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
  form { display: flex; gap: 8px; }
  .mode { display: flex; gap: 14px; margin: 10px 4px 0; font-size: 13px; color: var(--muted); }
  .mode label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .mode input { margin: 0; accent-color: var(--accent); }
  .card.raw { grid-template-columns: 1fr auto; }
  .card.raw .t { font-size: 13px; word-break: break-all; }
  .card.raw .m a { color: var(--accent); text-decoration: none; }
  input[type=search] { flex: 1; min-width: 0; font: inherit; font-size: 17px; padding: 12px 16px; border: 1px solid var(--hair);
    border-radius: 999px; background: var(--panel); color: var(--ink); }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 999px; padding: 11px 18px;
    background: var(--accent); color: var(--accent-ink); font-weight: 550; }
  button:disabled { opacity: .5; cursor: default; }
  button.ghost { background: transparent; color: var(--ink); border-color: var(--hair); }
  h2 { font-size: 13px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); margin: 36px 0 12px; }
  /* A section heading that is also the way to the other page, rather than a footer link. */
  h2 a { color: var(--accent); text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  .card { display: grid; grid-template-columns: 64px 1fr auto; gap: 14px; align-items: start; padding: 12px; margin-bottom: 10px;
    background: var(--panel); border: 1px solid var(--hair); border-radius: var(--radius); }
  .card img, .card .noimg { width: 64px; height: 96px; object-fit: cover; border-radius: 8px; background: var(--chip); }
  .t { font-weight: 600; }
  .m { color: var(--muted); font-size: 13px; }
  .o { font-size: 13px; margin-top: 4px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tag { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; padding: 2px 8px;
    border-radius: 999px; background: var(--chip); color: var(--muted); margin-right: 6px; vertical-align: middle; }
  .tag.lib { background: var(--good); color: #fff; }
  .act { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .act button { padding: 8px 14px; font-size: 13px; white-space: nowrap; }
  .act.pick { grid-column: 1 / -1; align-items: stretch; }
  .seasons { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .seasons label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; padding: 4px 8px; border: 1px solid var(--hair); border-radius: 999px; background: var(--chip); cursor: pointer; }
  .seasons label:has(input:checked) { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .seasons input { margin: 0; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .q { padding: 10px 12px; margin-bottom: 8px; background: var(--panel); border: 1px solid var(--hair); border-radius: var(--radius); }
  .bar { height: 6px; border-radius: 3px; background: var(--chip); overflow: hidden; margin-top: 6px; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .msg { color: var(--muted); font-size: 14px; padding: 12px 0; }
  .ok { color: var(--good); }
  .err { color: #b3261e; }
  .warn { color: #8a5a00; }
  @media (prefers-color-scheme: dark) { .warn { color: #e0b25a; } }
  .foot { max-width: 860px; margin: 0 auto; padding: 24px 16px 40px; border-top: 1px solid var(--hair); color: var(--muted); font-size: 13px; }
  /* Phone layout: full-width stacked search, posters smaller, buttons under the text and
     big enough to thumb, season chips wrap, queue rows tighter. */
  @media (max-width: 600px) {
    .wrap { padding: max(16px, env(safe-area-inset-top)) 12px 72px; }
    h1 { font-size: 19px; }
    .lede { margin-bottom: 14px; }
    form { flex-direction: column; }
    input[type=search] { font-size: 16px; padding: 12px 14px; }
    button { padding: 12px 16px; }
    .mode { gap: 12px; margin-top: 8px; flex-wrap: wrap; }
    .card { grid-template-columns: 52px 1fr; gap: 10px; padding: 10px; }
    .card img, .card .noimg { width: 52px; height: 78px; }
    .act { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; }
    .act button { flex: 1 1 auto; padding: 11px 14px; font-size: 14px; }
    .act.pick .row button { flex: 1 1 45%; }
    .seasons label { padding: 8px 12px; font-size: 14px; }
    .card.raw { grid-template-columns: 1fr; }
    .card.raw .t { font-size: 12px; }
    .o { -webkit-line-clamp: 3; }
    .q { padding: 9px 10px; }
    .q .t { font-size: 14px; }
    .q .m { display: block; font-size: 12px; }
  }
  @media (pointer: coarse) { button, .seasons label { min-height: 44px; } .mode label { min-height: 40px; } }
</style>
`;

const PAGE = (email, autoAdd) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#fbfbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14140f" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Download">
<meta name="robots" content="noindex">
<title>download.ephix.net</title>
${STYLES}
</head>
<body>
<div class="wrap">
  <h1>download.ephix.net</h1>
  <p class="lede">Type a show or a film. Add it, and it downloads at home.</p>
  <form id="f" autocomplete="off">
    <input id="q" type="search" placeholder="Slow Horses, Heat 1995, The Pitt…" autofocus>
    <button type="submit" id="go">Search</button>
  </form>
  <div class="mode" role="radiogroup" aria-label="Search mode">
    <label><input type="radio" name="mode" value="lib" checked> Shows &amp; films</label>
    <label><input type="radio" name="mode" value="raw"> Raw torrents <span class="m">→ Other</span></label>
  </div>
  <div id="msg" class="msg"></div>
  <div id="results"></div>
  <div id="pendwrap" hidden><h2>Waiting for home to come online</h2><div id="pending"></div></div>
  <h2>Downloading now</h2>
  <div id="queue" class="msg">Nothing in the queue.</div>
  <h2>Recently downloaded</h2>
  <div id="history" class="msg">Loading&hellip;</div>
  <h2><a href="/shows">Subscriptions &amp; cancelling &rarr;</a></h2>
</div>
<footer class="foot">Signed in as ${escapeHtml(email)} · Sonarr &amp; Radarr at home</footer>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const mode = () => document.querySelector('input[name=mode]:checked').value;
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  $('#q').placeholder = mode() === 'raw' ? 'anything — release names, sport, documentaries…' : 'Slow Horses, Heat 1995, The Pitt…';
  if ($('#q').value.trim()) $('#f').requestSubmit();
}));

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim(); if (!q) return;
  $('#go').disabled = true; $('#msg').textContent = 'Searching…'; $('#results').innerHTML = '';
  try {
    if (mode() === 'raw') {
      const r = await fetch('/api/raw?q=' + encodeURIComponent(q)).then((r) => r.json());
      if (r.error) throw new Error(/unreachable|5\\d\\d|redirected/.test(r.error) ? 'Raw search needs home online — it asks the indexers through the laptop.' : r.error);
      $('#msg').textContent = r.results.length ? (r.hidden ? 'Hid ' + r.hidden + ' executable-named fake(s).' : '') : 'Nothing found.';
      $('#results').innerHTML = r.results.map((x) => rawRow(x, q)).join('');
    } else {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      $('#msg').innerHTML = r.offline
        ? '<span class="warn">Home is offline — showing TMDB results. Anything you add is queued and picked up when the laptop is back.</span>'
        : (r.results.length ? '' : 'Nothing matched on TVDB or TMDB.');
      $('#results').innerHTML = r.results.map(card).join('');
    }
  } catch (err) { $('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
  $('#go').disabled = false;
});

// Raw torrent results: release name, size, seeders, indexer. Grab sends it through
// Prowlarr into qBittorrent under the "other" category (Media\\Other), untouched by Sonarr/Radarr.
function rawRow(x, q) {
  // q travels with the pick so the Worker can re-run the search and verify this result
  // itself rather than trusting the guid we hand it.
  const data = esc(JSON.stringify({ guid: x.guid, indexerId: x.indexerId, q: q }));
  return '<div class="card raw"><div><div class="t">' + esc(x.title) + '</div>'
    + '<div class="m">' + x.gb + ' GB · <b>' + x.seeders + '</b> seeders · ' + x.leechers + ' leechers · ' + esc(x.indexer) + (x.age ? ' · ' + esc(x.age) : '')
    + (x.info ? ' · <a href="' + esc(x.info) + '" target="_blank" rel="noopener">info</a>' : '') + '</div></div>'
    + '<div class="act"><button data-grab="' + data + '" onclick="grabRaw(this)">Grab → Other</button></div></div>';
}

async function grabRaw(btn) {
  const box = btn.closest('.act'); btn.disabled = true; btn.textContent = 'Grabbing…';
  try {
    const r = await fetch('/api/grab', { method: 'POST', headers: { 'content-type': 'application/json' }, body: btn.dataset.grab }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    box.innerHTML = '<span class="ok">' + (r.queued ? 'Queued — home is offline' : 'Sent to qBittorrent → Media\\\\Other') + '</span>';
  } catch (err) { box.innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
}

// A result is identified by a TVDB id (from Sonarr) or, when home is offline, a TMDB id.
// Both are passed through; the Worker uses whichever is present.
function card(x) {
  const img = x.poster ? '<img src="' + esc(x.poster) + '" alt="" loading="lazy">' : '<div class="noimg"></div>';
  const lib = x.inLibrary ? '<span class="tag lib">In library' + (x.files != null ? ' · ' + x.files + ' files' : '') + '</span>' : '';
  const ids = (x.id || 0) + ',' + (x.tmdbId || 0);
  const act = x.inLibrary ? '' : x.type === 'tv'
    ? '<button onclick="pickSeasons(this,' + ids + ')">Add…</button>'
    : '<button onclick="add(this,\\'movie\\',' + (x.id || x.tmdbId) + ')">Add film</button>';
  return '<div class="card">' + img + '<div><div class="t">' + esc(x.title) + (x.year ? ' <span class="m">(' + x.year + ')</span>' : '') + '</div>'
    + '<div class="m"><span class="tag">' + (x.type === 'tv' ? 'TV' : 'Film') + '</span>' + lib + esc(x.network) + (x.status ? ' · ' + esc(x.status) : '') + '</div>'
    + '<div class="o">' + esc(x.overview) + '</div></div><div class="act">' + act + '</div></div>';
}

// TV: never add a whole back-catalogue by accident. Show the seasons, pre-select the
// latest, and make "all" an explicit choice. New episodes stay monitored whatever is picked.
async function pickSeasons(btn, tvdbId, tmdbId) {
  const box = btn.closest('.act'); btn.disabled = true; btn.textContent = 'Loading…';
  const ids = tvdbId + ',' + tmdbId;
  try {
    const s = await fetch('/api/seasons?' + (tvdbId ? 'tvdbId=' + tvdbId : 'tmdbId=' + tmdbId)).then((r) => r.json());
    if (s.error) throw new Error(s.error);
    if (s.inLibrary) { box.className = 'act'; box.innerHTML = '<span class="ok">Already in the library</span>'; return; }
    const last = s.seasons[s.seasons.length - 1];
    box.className = 'act pick';
    box.innerHTML = '<div class="seasons">' + s.seasons.map((n) =>
      '<label><input type="checkbox" value="' + n + '"' + (n === last ? ' checked' : '') + '> S' + String(n).padStart(2, '0') + '</label>').join('') + '</div>'
      + '<div class="row"><button onclick="addSeasons(this,' + ids + ')">Add selected</button>'
      + '<button class="ghost" onclick="add(this,\\'tv\\',' + tvdbId + ',\\'future\\',null,' + tmdbId + ')">New episodes only</button>'
      + '<button class="ghost" onclick="if(confirm(\\'Add all ' + s.seasons.length + ' seasons?\\'))add(this,\\'tv\\',' + tvdbId + ',\\'all\\',null,' + tmdbId + ')">All ' + s.seasons.length + ' seasons</button></div>';
  } catch (err) { box.innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
}

function addSeasons(btn, tvdbId, tmdbId) {
  const picked = [...btn.closest('.act').querySelectorAll('input:checked')].map((i) => Number(i.value));
  if (!picked.length) { alert('Tick at least one season'); return; }
  add(btn, 'tv', tvdbId, 'seasons', picked, tmdbId);
}

async function add(btn, type, id, mode, seasons, tmdbId) {
  const box = btn.closest('.act'); box.querySelectorAll('button,input').forEach((b) => (b.disabled = true));
  btn.textContent = 'Adding…';
  // title/year ride along only so a queued request can be displayed while home is offline
  const card = btn.closest('.card');
  const title = card?.querySelector('.t')?.childNodes[0]?.textContent?.trim() || '';
  const year = card?.querySelector('.t .m')?.textContent?.replace(/[()]/g, '') || '';
  try {
    const body = { type, id: id || undefined, tmdbId: tmdbId || undefined, mode, seasons, title, year };
    const r = await fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const what = mode === 'seasons' ? ' (S' + seasons.join(', S') + ' + new)' : mode === 'future' ? ' (new episodes only)' : mode === 'all' ? ' (all seasons)' : '';
    box.className = 'act';
    box.innerHTML = '<span class="ok">' + (r.queued ? 'Queued — home is offline, will add automatically' : r.already ? 'Already added' : 'Added — searching' + what) + '</span>';
    setTimeout(loadQueue, 4000); setTimeout(loadQueue, 15000);
  } catch (err) { box.className = 'act'; box.innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
}

async function loadQueue() {
  try {
    const [r, p] = await Promise.all([fetch('/api/queue').then((r) => r.json()), fetch('/api/pending').then((r) => r.json())]);
    if (r.error) throw new Error(r.error);
    const pend = p.pending || [];
    $('#pendwrap').hidden = !pend.length;
    $('#pending').innerHTML = pend.map((i) =>
      '<div class="q"><div class="t">' + esc(i.title || (i.type + ' ' + i.id)) + (i.year ? ' <span class="m">(' + esc(i.year) + ')</span>' : '')
      + ' <span class="m">· ' + (i.type === 'tv' ? 'TV' : 'Film') + ' · asked ' + new Date(i.at).toLocaleString() + (i.tries ? ' · ' + i.tries + ' retries' : '') + '</span></div>'
      + (i.lastError ? '<div class="m">' + esc(i.lastError) + '</div>' : '') + '</div>').join('');
    if (r.offline) {
      $('#queue').className = 'msg';
      $('#queue').textContent = 'Home is offline — the laptop or its internet is down. Requests are queued and retried every 5 minutes.';
      return;
    }
    $('#queue').className = r.items.length ? '' : 'msg';
    $('#queue').innerHTML = r.items.length ? r.items.map((i) =>
      '<div class="q"><div class="t">' + (i.via ? '<span class="tag">' + esc(i.via) + '</span>' : '') + esc(i.title) + ' <span class="m">' + i.pct + '% · ' + i.gb + ' GB' + (i.speed ? ' · ' + esc(i.speed) : '') + (i.eta ? ' · ' + esc(i.eta) + ' left' : '') + ' · ' + esc(i.status) + '</span></div>'
      + '<div class="m">' + esc(i.release) + '</div><div class="bar"><i style="width:' + i.pct + '%"></i></div></div>').join('')
      : 'Nothing in the queue.';
  } catch (err) { $('#queue').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
}
loadQueue(); setInterval(loadQueue, 10000);

// How long ago, in the fewest characters that still mean something.
function ago(iso) {
  const t = new Date(iso); if (isNaN(t)) return '';
  const mins = Math.round((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  if (mins < 2880) return 'yesterday';
  if (mins < 10080) return Math.round(mins / 1440) + 'd ago';
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Polled far more slowly than the queue: imports are minutes apart at best, and this
// costs two calls to home each time.
async function loadHistory() {
  try {
    const r = await fetch('/api/history').then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.offline) { $('#history').className = 'msg'; $('#history').textContent = 'Home is offline, so there is no history to show.'; return; }
    $('#history').className = r.items.length ? '' : 'msg';
    $('#history').innerHTML = r.items.length ? r.items.map((i) =>
      '<div class="q"><div class="t"><span class="tag">' + esc(i.via) + '</span>' + esc(i.title)
      + ' <span class="m">' + esc(ago(i.at)) + (i.gb > 0 ? ' · ' + i.gb + ' GB' : '') + (i.quality ? ' · ' + esc(i.quality) : '') + '</span></div>'
      + (i.sub ? '<div class="m">' + esc(i.sub) + '</div>' : '') + '</div>').join('')
      : 'Nothing downloaded yet.';
  } catch (err) { $('#history').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
}
loadHistory(); setInterval(loadHistory, 60000);

// Opened as download.ephix.net/?add=tv:<tmdb>|movie:<tmdb> (fallback path from an Ephix Pulse card)
const autoAdd = ${JSON.stringify(autoAdd || '')};
if (/^(tv|movie):\\d+$/.test(autoAdd)) {
  const [type, tmdbId] = autoAdd.split(':');
  $('#msg').textContent = 'Adding…';
  fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, tmdbId: Number(tmdbId), mode: type === 'tv' ? 'latest' : 'all' }) })
    .then((r) => r.json())
    .then((r) => { if (r.error) throw new Error(r.error);
      $('#msg').innerHTML = '<span class="ok">' + esc(r.title || '') + ': ' + (r.queued ? 'queued — home is offline, will add automatically' : r.already ? 'already in the library' : 'added — searching now') + '</span>';
      setTimeout(loadQueue, 4000); setTimeout(loadQueue, 15000); })
    .catch((err) => { $('#msg').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; });
  history.replaceState(null, '', '/');
}
</script>
</body>
</html>`;

// The other half of the app: what you have already committed to, and how to stop it.
const SUBS_PAGE = (email) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#fbfbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14140f" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Shows">
<meta name="robots" content="noindex">
<title>Subscriptions</title>
${STYLES}
<style>
  button.danger { background: transparent; color: #b3261e; border-color: var(--hair); }
  @media (prefers-color-scheme: dark) { button.danger { color: #ff8a80; } }
  .nav { font-size: 13px; margin: 0 0 22px; }
  .nav a { color: var(--accent); text-decoration: none; }
  .card.gone { opacity: .45; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Subscriptions</h1>
  <p class="lede">What the library is committed to. Pause stops new grabs, Remove makes Sonarr forget it. Neither touches a file you already have.</p>
  <div class="nav"><a href="/">&larr; Add something</a></div>
  <div id="msg" class="msg">Loading&hellip;</div>
  <div id="tvwrap" hidden><h2>TV</h2><div id="tv"></div></div>
  <div id="filmwrap" hidden><h2>Films waiting</h2><div id="films"></div></div>
  <div id="pausedwrap" hidden><h2>Paused</h2><div id="paused"></div></div>
</div>
<footer class="foot">Signed in as ${escapeHtml(email)} &middot; Sonarr &amp; Radarr at home</footer>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = (d) => { const t = new Date(d); return isNaN(t) ? '' : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };

// One line under the title saying why this row is still on the page.
function meta(x) {
  const bits = [];
  if (!x.monitored) bits.push('<span class="tag">Paused</span>');
  else if (x.next) bits.push('<span class="tag lib">' + (x.type === 'tv' ? 'Next ' : 'Due ') + esc(when(x.next)) + '</span>');
  else if (x.status === 'ended') bits.push('<span class="tag">Ended</span>');
  else bits.push('<span class="tag">No date yet</span>');
  if (x.type === 'tv') {
    bits.push(x.have + '/' + x.total + ' episodes');
    if (x.seasons) bits.push(x.seasons + (x.seasons === 1 ? ' season' : ' seasons') + ' monitored');
  } else {
    bits.push('waiting for a release');
  }
  if (x.by) bits.push(esc(x.by));
  return bits.join(' &middot; ');
}

function row(x) {
  const img = x.poster ? '<img src="' + esc(x.poster) + '" alt="" loading="lazy">' : '<div class="noimg"></div>';
  const pct = x.total ? Math.round((x.have / x.total) * 100) : 0;
  const bar = x.type === 'tv' ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '';
  const data = esc(JSON.stringify({ type: x.type, id: x.id, title: x.title }));
  return '<div class="card" data-sub="' + data + '">' + img
    + '<div><div class="t">' + esc(x.title) + (x.year ? ' <span class="m">(' + x.year + ')</span>' : '') + '</div>'
    + '<div class="m">' + meta(x) + '</div>' + bar + '</div>'
    + '<div class="act">'
    + '<button class="ghost" onclick="act(this,\\'' + (x.monitored ? 'pause' : 'resume') + '\\')">' + (x.monitored ? 'Pause' : 'Resume') + '</button>'
    + '<button class="ghost danger" onclick="act(this,\\'remove\\')">Remove</button>'
    + '</div></div>';
}

async function act(btn, action) {
  const card = btn.closest('.card');
  const sub = JSON.parse(card.dataset.sub);
  if (action === 'remove' && !confirm('Remove ' + sub.title + '?\\n\\nIt stops being tracked and no new episodes are grabbed. Everything already downloaded stays on disk.')) return;
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch('/api/sub', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: sub.type, id: sub.id, action: action }) }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.removed) {
      card.classList.add('gone');
      card.querySelector('.act').innerHTML = '<span class="m">Removed</span>';
      return;
    }
    load();
  } catch (err) {
    card.querySelector('.act').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
}

async function load() {
  try {
    const r = await fetch('/api/subs').then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const paused = r.paused || [];
    $('#tv').innerHTML = r.tv.map(row).join('');
    $('#films').innerHTML = r.films.map(row).join('');
    $('#paused').innerHTML = paused.map(row).join('');
    $('#tvwrap').hidden = !r.tv.length;
    $('#filmwrap').hidden = !r.films.length;
    $('#pausedwrap').hidden = !paused.length;
    $('#msg').textContent = (r.tv.length || r.films.length || paused.length) ? '' : 'Nothing subscribed yet.';
  } catch (err) {
    const offline = /unreachable|redirected|5\\d\\d/.test(err.message);
    $('#msg').innerHTML = '<span class="' + (offline ? 'warn' : 'err') + '">'
      + esc(offline ? 'Cannot reach home right now, so there is nothing to show. The list needs Sonarr and Radarr.' : err.message) + '</span>';
  }
}
load();
</script>
</body>
</html>`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
