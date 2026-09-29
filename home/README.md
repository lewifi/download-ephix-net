# Media automation — this laptop

## Status (2026-09-22)
| Piece | State |
|---|---|
| qBittorrent Web UI, localhost bypass | ✅ on, `http://localhost:8080` |
| qBittorrent excluded file names (`*.scr *.exe …`), save path → `Incoming\` | ✅ |
| `Get-Torrent.ps1` | ✅ tested, rejects `.exe` fakes |
| Prowlarr 2.6.5 service | ✅ running, indexers: The Pirate Bay, YTS, Knaben, TorrentsCSV |
| Radarr 6.4.4 service | ✅ running; root `Movies\`, naming, hardlinks, qBittorrent client, Prowlarr link; 13 films imported |
| Sonarr 4.0.20 service | ✅ running; root `TV\`, naming, hardlinks, qBittorrent client, Prowlarr link; 6 shows imported (monitor: future episodes only) |
| Auto-update | ✅ on in all three (Settings → General → Updates) |
| No seeding | ✅ qBittorrent share ratio 0 → stop. Finished torrents stay in the list as *Completed* (history of what was grabbed); their `Incoming\` file is a hardlink of the library copy, so it costs no disk |
| 1337x / EZTV / LimeTorrents in Prowlarr | ❌ Cloudflare-blocked or bad TLS on every mirror — skipped, Knaben covers them |

API keys live in `C:\ProgramData\<App>\config.xml` if ever needed.

### Permissions (already applied — here for reference / the Mini PC)
Sonarr, Radarr and Prowlarr run as `NT AUTHORITY\LocalService`, which has no rights on a
user profile. Modify on the Media tree, plus read-only *this-folder-only* on the two
parents so the account can pass through them:
```powershell
icacls "C:\Users\lewih\Downloads\Media" /grant "NT AUTHORITY\LocalService:(OI)(CI)M" /T /Q; icacls "C:\Users\lewih" /grant "NT AUTHORITY\LocalService:(RX)"; icacls "C:\Users\lewih\Downloads" /grant "NT AUTHORITY\LocalService:(RX)"
```
Sonarr's winget installer skipped registering its service; it was added by hand:
```powershell
sc.exe create Sonarr binPath= "C:\ProgramData\Sonarr\bin\Sonarr.Console.exe" start= auto obj= "NT AUTHORITY\LocalService" DisplayName= "Sonarr"; sc.exe start Sonarr
```
If Sonarr's self-updater leaves the service showing *Stopped* while the app still answers:
```powershell
Stop-Process -Name Sonarr.Console -Force; Start-Service Sonarr
```

Target: `C:\Users\lewih\Downloads\Media` (Plex already runs here). If you set this up
on the Mini PC instead, the steps are identical — swap the paths for `D:\data\...`
as in the original handoff.

Two paths, layered. Path 1 works today with nothing installed. Path 2 is the full
"add a show once, never think about it again" setup.

---

## Path 1 — search + grab from qBittorrent (no installs)

qBittorrent's search tab is exposed over its Web API, so a script (or Claude) can
drive the same plugins you see in the GUI.

### One-time: turn on the Web UI (you do this, ~30 seconds)
qBittorrent → **Tools → Options → Web UI**
1. Tick **Web User Interface (Remote control)**. IP `*`, port `8080`.
2. Tick **Bypass authentication for clients on localhost**.
   (Leave the username/password fields at their defaults — nothing on this
   machine needs them, and it means no credentials ever go in a script.)
3. **Apply**.

Check it took:
```powershell
Invoke-RestMethod http://localhost:8080/api/v2/app/version
```
Should print `v5.2.3`.

### Use it
```powershell
cd "C:\Users\lewih\Downloads\Media\App"; .\Get-Torrent.ps1 "Reacher S04E09"
```
- Searches every enabled plugin, filters to 1080p, sorts by seeders, adds the top
  result to qBittorrent under `C:\Users\lewih\Downloads\Media\Incoming`.
- `-List` shows the top 10 and asks which to grab instead of auto-picking.
- `-DryRun` just shows the list. `-Quality 2160p` / `720p`, `-MinSeeders 20`, `-MinGB 1`.

### Malware guard (.scr / .exe "episodes")
Public trackers carry fakes named like `Show S04E08 1080p WEB h264 EZTV.exe` — and
they're often the *most seeded* result (one had 2,131 seeders on a test search).
Three layers, all already configured:

1. **Script** rejects any result whose name has an executable extension
   (`.exe .scr .msi .bat .lnk .zipx .iso …`) and anything under 0.3 GB, and prints
   what it threw out so you can see it working.
2. **qBittorrent → Options → Downloads → Excluded file names** is ON with
   `*.scr *.exe *.msi *.com *.bat *.cmd *.ps1 *.vbs *.js *.jar *.hta *.pif *.lnk *.url *.reg *.dll`
   (+ the `*.txt *.nfo *.jpg` junk). Those files are skipped inside *any* torrent,
   however it was added — Sonarr, script, or by hand.
3. **Sonarr/Radarr** only ever import video extensions into `TV\`/`Movies\`; anything
   else stays in `Incoming\` and never reaches the Plex library.

Nothing in the stack executes downloaded files. The residual risk is you
double-clicking something in `Incoming\` yourself — don't; the library folders
are the only ones worth opening.

Files still land with release-group names; the sorting rule (TV\Show\Season NN,
clean filename) is applied afterwards, by hand or by asking Claude. Path 2 removes
that step.

---

## Path 2 — the arr stack (Sonarr + Radarr + Prowlarr + qBittorrent)

| App | Job | URL |
|---|---|---|
| **Prowlarr** | One place to hold torrent sites; pushes them to Sonarr/Radarr | http://localhost:9696 |
| **Sonarr** | TV: watches for new episodes, sends to qBittorrent, renames into `TV\` | http://localhost:8989 |
| **Radarr** | Same for films → `Movies\` | http://localhost:7878 |
| **qBittorrent** | Actually downloads (already installed) | http://localhost:8080 |

Flow: you type a show into Sonarr → Sonarr asks Prowlarr's indexers → best match goes
to qBittorrent → when done, Sonarr moves it to `TV\<Show>\Season NN\<Show> - SxxEyy - <Title>.mkv`
→ Plex picks it up. New episodes each week are grabbed automatically.

### Install (all from winget, latest stable — verified 2026-09-22)
```powershell
winget install --id TeamProwlarr.Prowlarr --exact --accept-package-agreements --accept-source-agreements
```
```powershell
winget install --id TeamSonarr.Sonarr --exact --accept-package-agreements --accept-source-agreements
```
```powershell
winget install --id TeamRadarr.Radarr --exact --accept-package-agreements --accept-source-agreements
```
Versions at time of writing: Prowlarr 2.3.0, Sonarr 4.0.14, Radarr 6.0.4.
The installers default to running as a Windows service (starts with the machine,
no login needed). Confirm afterwards:
```powershell
Get-Service Sonarr, Radarr, Prowlarr
```

### Folders
```
C:\Users\lewih\Downloads\Media\
├── Incoming\            <-- qBittorrent downloads here (staging)
│   ├── tv\
│   └── movies\
├── TV\                  <-- Sonarr root folder = Plex TV library
└── Movies\              <-- Radarr root folder = Plex Movies library
```
Same NTFS volume, so Sonarr/Radarr *hardlink* instead of copying. Seeding is off
(qBittorrent → Options → BitTorrent → share ratio limit 0, action Stop). Finished torrents
are left in qBittorrent as *Completed* so the list doubles as a download history; the file
in `Incoming\` is a hardlink of the one in `TV\`/`Movies\`, so it uses no extra space.
Deleting a torrent "with files" later only removes the `Incoming\` copy, never the library one.

### Configure — in this order

**1. qBittorrent** (Tools → Options)
- Web UI: as in Path 1.
- Downloads → Default Save Path: `C:\Users\lewih\Downloads\Media\Incoming`
- In the left sidebar of the main window, right-click **Categories → Add**:
  - `tv-sonarr`, save path `C:\Users\lewih\Downloads\Media\Incoming\tv`
  - `movies-radarr`, save path `C:\Users\lewih\Downloads\Media\Incoming\movies`

**2. Prowlarr** (http://localhost:9696)
- Indexers → **+** → add public ones: 1337x, TorrentGalaxy, EZTV, YTS, The Pirate Bay.
  Test each; drop any that fail.

**3. Sonarr** (http://localhost:8989)
- Settings → Media Management → **Root Folders** → add `C:\Users\lewih\Downloads\Media\TV`
- Settings → Media Management → Episode Naming → **Rename Episodes: on**, then:
  - Standard Episode Format: `{Series TitleWithoutYear} - S{season:00}E{episode:00} - {Episode Title}`
  - Series Folder Format: `{Series TitleWithoutYear}`  (plain `{Series Title}` leaks TVDB's year for shows like *Sugar (2024)*)
  - Colon Replacement: Custom, `.`  (so `7:00 A.M.` → `7.00 A.M.`)
  - Season Folder Format: `Season {season:00}`
  (this reproduces the existing library layout exactly)
- Settings → Media Management → File Management → **Use Hardlinks instead of Copy: on**
- Settings → Download Clients → **+** → qBittorrent:
  Host `localhost`, port `8080`, no username/password (localhost bypass),
  Category `tv-sonarr`. Test → Save.
- Settings → General → copy Sonarr's **API Key**.

**4. Radarr** (http://localhost:7878) — same shape:
- Root folder `C:\Users\lewih\Downloads\Media\Movies`
- Movie Naming: Rename on. Standard: `{Movie Title} ({Release Year})`,
  Movie Folder Format: `{Movie Title} ({Release Year})`
- Hardlinks on. Download client qBittorrent, category `movies-radarr`.
- Copy Radarr's API Key.

**5. Wire Prowlarr → Sonarr/Radarr** (Prowlarr → Settings → Apps → **+**)
- Sonarr: Prowlarr Server `http://localhost:9696`, Sonarr Server `http://localhost:8989`,
  paste Sonarr's API key. Test → Save.
- Radarr: same with `7878` and Radarr's key.
Prowlarr now pushes every indexer to both apps; you never add indexers in Sonarr/Radarr directly.

**6. Import what's already there** *(done 2026-09-22 — 6 shows, 13 films)*
Sonarr → Series → **Import Existing** → pick `TV\` → it scans Lanterns, Reacher, Sugar,
The Bear, The Pitt, The Studio and matches them. Set each to **Monitor: Future Episodes**
so it doesn't try to re-download seasons you already have. Radarr → Movies → Import Existing → `Movies\`.

### Daily use — the short version
Three scripts in this folder. Any of them can be run by you in PowerShell or by Claude in chat.

```powershell
cd "C:\Users\lewih\Downloads\Media\App"; .\Find-Title.ps1 "Slow Horses"
```
Is it a show or a film, is it already in the library, what does TVDB/TMDB think it is.
Add `-Releases` to also list what the indexers have right now (best-seeded first,
executable-named fakes hidden).

```powershell
cd "C:\Users\lewih\Downloads\Media\App"; .\Add-Title.ps1 -Show "Slow Horses"
```
Adds it to Sonarr, which immediately searches, downloads via qBittorrent, renames into
`TV\Slow Horses\Season NN\` and keeps grabbing new episodes as they air.
- `-Season 5` → only that season. `-FutureOnly` → nothing back-catalogue, just new episodes.
- `-Movie "Heat" -Year 1995` → same through Radarr into `Movies\Heat (1995)\`.
- `-TvdbId` / `-TmdbId` when the name is ambiguous (Find-Title prints the ids).
- Watch progress at http://localhost:8989/activity/queue (or 7878 for films).

```powershell
cd "C:\Users\lewih\Downloads\Media\App"; .\Get-Torrent.ps1 "Some Documentary 2024" -List
```
Escape hatch for things not on TVDB/TMDB: raw qBittorrent search, pick one, it lands in
`Incoming\` with the release name and you file it by hand.

### Audio language (dual-audio releases)
Some releases (`ENG.ITA…-TBK`, `DUAL`, `MULTi`) carry a foreign track first and flagged
default, so players start in Italian. Three layers:
1. **Preferred audio language is an *account* setting, not a client or library one.**
   It is not in the Plex app on Google TV (that app has no audio/subtitle section at all),
   and since PMS 1.43 it is not per-library either. Set it once on the account and every
   client honours it. Two fields have to be right: `defaultAudioLanguage` = `en` **and**
   `autoSelectAudio` = `true`. With autoSelect off, Plex ignores the language preference
   entirely and just plays whichever track the file flags as default, which is why layer 2
   below is what has actually been doing the work. Checked 2026-09-22: language was already
   `en`, `autoSelectAudio` was `false`; now set true. To read or change them:
   ```powershell
   $t = (Get-ItemProperty 'HKCU:\Software\Plex, Inc.\Plex Media Server' -Name PlexOnlineToken).PlexOnlineToken
   $h = @{ 'X-Plex-Token' = $t; 'Accept' = 'application/json'; 'X-Plex-Client-Identifier' = 'readme' }
   (Invoke-RestMethod 'https://plex.tv/api/v2/user' -Headers $h).profile
   Invoke-RestMethod 'https://plex.tv/api/v2/user/profile?autoSelectAudio=1' -Method Put -Headers $h
   ```
2. `App\Set-EnglishAudio.ps1` flips the MKV default flag to the English track (mkvpropedit,
   metadata only, ~1 s). Sonarr/Radarr run it automatically on every import (Settings →
   Connect → "English audio default"); log in `App\Set-EnglishAudio.log`. To sweep by hand:
   ```powershell
   cd "C:\Users\lewih\Downloads\Media\App"; .\Set-EnglishAudio.ps1 "C:\Users\lewih\Downloads\Media\Movies" -Recurse
   ```
3. Custom format "Foreign dub / dual audio" (−200 in every profile) makes Sonarr/Radarr prefer
   a clean English release over an `ITA`/`DUAL`/`MULTi`-tagged one when both exist. It never
   blocks a release outright — the script covers the case where the dual-audio one is all
   that's available.
Requires MKVToolNix (`winget install MoritzBunkus.MKVToolNix`).

### Daily use after setup
- New show: Sonarr → Series → Add New → type the name → pick quality profile
  (HD-1080p) → Add. Done; it grabs from now on.
- One film: Radarr → Movies → Add New → same.
- The Get-Torrent.ps1 script still works for anything odd (documentaries, sport,
  stuff not in TheTVDB) — just drop the file into `TV\` afterwards.

### Optional: auto-clean (from the handoff)
- Plex → library → Manage Library → Advanced → *Delete episodes after playing*
  for throwaway shows; leave The Bear etc. on Never.
- Sonarr/Radarr → Settings → Media Management → **Unmonitor Deleted Episodes/Movies: on**,
  so a Plex-deleted file isn't re-grabbed.
- Disk isn't the constraint on this box (C: 1.4 TB free) — this only matters on the
  500 GB Mini PC.

### VPN note
The handoff's advice stands: if you run a VPN, bind qBittorrent to its adapter
(Tools → Options → Advanced → Network Interface) so downloads stop when it drops.
Sonarr/Radarr/Prowlarr only talk to localhost and indexer sites; they don't need
the binding.
