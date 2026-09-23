# download.ephix.net

A gated search bar that adds shows and films to Sonarr/Radarr running on the laptop at
home (see `C:\Users\lewih\Downloads\Media\App\README.md` for that side).

```
phone/browser ─▶ Cloudflare Access (one-time PIN to your email)
              ─▶ Worker  download.ephix.net        (this repo)
              ─▶ sonarr-api.ephix.net / radarr-api.ephix.net   (Cloudflare Tunnel, same Access app)
              ─▶ cloudflared service on the laptop ─▶ Sonarr :8989 / Radarr :7878
```

Nothing is reachable without the Access login: the Worker verifies the Access JWT on every
request (and refuses everything if `ACCESS_AUD` is unset), and forwards that JWT to the
tunnel hostnames, which are in the same Access application.

## One-time setup

### 1. Tunnel (Cloudflare dashboard → Zero Trust → Networks → Tunnels)
1. **Create a tunnel** → Cloudflared → name `media` → Save.
2. On the install step pick **Windows 64-bit** and copy the `cloudflared.exe service install <token>`
   line. Run it in a PowerShell opened *as Administrator*. That registers the tunnel as a
   Windows service that starts with the machine.
3. **Public Hostname** tab → add two:
   - `sonarr-api` . `ephix.net` → Service `HTTP` `localhost:8989`
   - `radarr-api` . `ephix.net` → Service `HTTP` `localhost:7878`

### 2. Access application (Zero Trust → Access → Applications → Add → Self-hosted)
- Name `media`. Application domains, add all three:
  `download.ephix.net`, `sonarr-api.ephix.net`, `radarr-api.ephix.net`
- Identity: **One-time PIN** is enough (Zero Trust → Settings → Authentication if it
  isn't enabled yet).
- Policy: name `me`, action **Allow**, include **Emails** → your address(es).
- Save. Open the application again and copy:
  - **Application Audience (AUD) Tag** (long hex string, under Overview / Basic information)
  - your **team domain**, `<team>.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages)

### 3. Deploy the Worker
Put the two values into `wrangler.jsonc` → `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), then:

```powershell
cd "C:\Users\lewih\Dev\download.ephix.net"; wrangler secret put SONARR_API_KEY
```
```powershell
cd "C:\Users\lewih\Dev\download.ephix.net"; wrangler secret put RADARR_API_KEY
```
(keys are in `C:\ProgramData\Sonarr\config.xml` / `C:\ProgramData\Radarr\config.xml`)
```powershell
cd "C:\Users\lewih\Dev\download.ephix.net"; wrangler deploy
```
`routes[].custom_domain: true` creates the `download.ephix.net` DNS record for you.

### 4. Service token (required, not optional)

The Worker cannot reach the tunnel hostnames on your login. Access accepts a browser
session cookie or a service token, nothing else, so forwarding the visitor's JWT in
`Cf-Access-Jwt-Assertion` authenticates nothing: Access 302s the Worker to its own login
page, the Worker reads that 3xx as "home is offline", and the site sits on the TMDB
fallback forever while everything at home is running perfectly.

1. Zero Trust → Access controls → Service credentials → Service Tokens → Create.
   Copy the Client Secret, it is shown exactly once. Lost it? Three dots → Rotate secret
   issues a new one and keeps the same Client ID, so the policy below stays valid.
2. Create the policy: action **Service Auth**, include → **Service Token** → the one you
   just made, and *nothing else*. It has to be Service Auth. With Allow, Cloudflare's own
   warning says it, Access still wants an identity provider login and bounces the Worker.
   Do not add an email rule to this policy; the app's existing email policy is separate
   and stays untouched.
3. **Attach it to the app.** A policy made from the Policies page is *reusable* and starts
   attached to nothing, where it does exactly zero. Go to Access controls → Applications →
   `media` → Policies tab → Add existing policy → Plex → Save. The Policies list should
   then read `Used by applications: 1`.
4. Set both secrets, pasting each value when prompted:
   ```powershell
   cd "C:\Users\lewih\Dev\download.ephix.net"; npx wrangler secret put ACCESS_CLIENT_ID
   cd "C:\Users\lewih\Dev\download.ephix.net"; npx wrangler secret put ACCESS_CLIENT_SECRET
   ```
   The Client ID **ends in `.access`**, as in `9270c4c9…52aa.access`. Copy it with the
   dashboard's copy button. Selecting it by hand drops the suffix, and a truncated Client
   ID fails exactly like a wrong secret.

No redeploy needed, `originHeaders` prefers the token the moment it is set.

#### When it still says "home is offline"

All three of the above failed silently and identically the first time, as a 302 to the
login page. Check in this order, it goes from most to least conclusive:

- **Service Tokens → your token → Last Seen.** `Not Seen Yet` means Access has never
  validated it, so nothing downstream matters. `Usage` names the app it has been used on.
- **Policies list → Used by applications.** `0` means the policy is orphaned.
- **The cron probe.** `wrangler tail` and wait up to 5 minutes; the scheduled handler logs
  `probe sonarr via <credential>: <status>` every run. `via forwarded JWT` means the
  secrets are not set. A 302 means Access refused them, 200 means it all works.
- **The tunnel's own counter**, on the box: `http://127.0.0.1:20241/metrics`,
  `cloudflared_tunnel_total_requests`. If it does not move, nothing is reaching home at
  all and the fault is at Access, not in the ingress rules.

### 5. Check
- `https://download.ephix.net` in a private window → Access login page, not the app.
- `https://sonarr-api.ephix.net` likewise → Access login, never Sonarr's UI.
- Log in → search bar → search `The Pitt` → shows "In library".

## Optional hardening
- Sonarr/Radarr → Settings → General → Authentication → **Forms**, set a password.
  Access already gates them; this is a second lock for the tunnel hostnames.

## Offline queue (tested 2026-09-22, works)
If the laptop or its internet is down the tunnel is dead. The site keeps working anyway:
search and the season picker fall back to TMDB (via `ephix.net/api/tmdb`, no key needed),
and an Add is stored in KV (`QUEUE`, 7-day TTL) and retried by a cron (`*/5 * * * *`) until
Sonarr/Radarr accept it. The page shows a "Home is offline, showing TMDB results" note,
"Queued, home is offline" on the button, and a "Waiting for home to come online" list.
"Offline" is decided by how the origin call fails (network error, any 5xx, or an Access
redirect), not by matching error text. Retries reuse your Access token from request time
(valid 24 h); for longer outages set the service-token secrets and retries never expire.

## Host filtering in Sonarr/Radarr
Both apps reject requests whose Host header isn't in `<AllowedHosts>` in
`C:\ProgramData\<App>\config.xml` ("Bad Request - Invalid Hostname"). They must contain
`localhost,sonarr-api.ephix.net` / `localhost,radarr-api.ephix.net`, and the service must
be restarted after editing (the in-app restart is a no-op when running as a service). Radarr
gained this on its 6.4 update; watch for it after future updates.

## Notifications
Sonarr and Radarr post to **ntfy** topic `ephix-media-8ecb18e7fa66` on `ntfy.sh` when an
import finishes (Settings → Connect → "ntfy → phone"). Subscribe to that topic in the ntfy
app on the phone. The topic name is the only secret, so don't publish it.

## Cards on ephix.net
`Dev\ephixpulse-web\index.html` adds a ⬇ button to every card, only when
`download.ephix.net/api/me` answers, i.e. the browser holds the Access session. Public
visitors never see it. Films add in one tap; TV opens a season picker. Works offline too
(the picker reads TMDB and the add is queued).

## Raw torrent search (toggle on the page)
"Raw torrents → Other" searches Prowlarr directly (all indexers) for anything TVDB/TMDB
doesn't know: sport, one-off documentaries, obscure stuff. Results are filtered the same
way as `Get-Torrent.ps1` (no executable-named releases, nothing under 50 MB, results with
no download link dropped, TorrentsCSV only returns bare magnets) and sorted by seeders.
**Grab** asks Prowlarr to send the release to qBittorrent under category `other`, which
saves to `C:\Users\lewih\Downloads\Media\Other` with the release name as-is. Sonarr/Radarr
never touch that folder; point a Plex "Other videos" library at it if wanted.
Needs home online for the search; a grab made while offline is queued like an add.
Pieces: tunnel route `prowlarr-api.ephix.net → localhost:9696` (in the `media` Access app),
Worker secret `PROWLARR_API_KEY`, Prowlarr → Settings → Download Clients → "qBittorrent (raw
to Other)". Prowlarr's grab reply always says `protocol: unknown`, and that's cosmetic.

## What the page does
- Search → `/api/search` → Sonarr `series/lookup` + Radarr `movie/lookup` (TVDB/TMDB),
  posters, "In library" badges.
- Add → `/api/add` → same defaults as `Add-Title.ps1`: HD-1080p profile, season folders,
  hardlinks, search immediately. TV goes through a season picker: selected seasons, *new
  episodes only*, or a confirmed *all*.
- "Downloading now" → `/api/queue` every 10 s. Reads qBittorrent directly through
  `qbit-api.ephix.net` (everything active, incl. raw grabs; speed + ETA; TV/Film/Other tag,
  Sonarr/Radarr consulted for friendly names). Falls back to the two arr queues if the qBit
  route is down. qBittorrent's Web UI "server domains" must be `localhost;qbit-api.ephix.net`,
  **semicolon**-separated. A comma makes one bogus domain and locks *everyone* out
  (Sonarr/Radarr included) until qBittorrent is restarted with the ini fixed.
- Phone layout: stacked search, thumb-sized buttons, season chips wrap; tested at 390 px.
