# Moving the stack to the Mini PC

Moving Plex, Sonarr, Radarr, Prowlarr, qBittorrent and cloudflared from the laptop to a
Dell OptiPlex 7070 Micro, with the library on a 4 TB USB drive (`M:`) and downloads on a
separate 512 GB USB NVMe (`I:`).

**The Worker does not change.** It talks to `*-api.ephix.net`, which resolves through the
tunnel to whichever machine is running cloudflared. Nothing in Cloudflare needs touching:
same tunnel, same hostnames, same Access application, same service token.

## What is moving

Captured from the running system on 2026-09-23:

| Thing | Version | Config lives in | Paths to change |
|---|---|---|---|
| Sonarr | 4.0.20.3014 | `C:\ProgramData\Sonarr` | root folder |
| Radarr | 6.4.4.10685 | `C:\ProgramData\Radarr` | root folder |
| Prowlarr | 2.6.5.5623 | `C:\ProgramData\Prowlarr` | none |
| qBittorrent | 5.2.3 | `%APPDATA%\qBittorrent` | save path |
| Plex | 1.43.4 | `%LOCALAPPDATA%\Plex Media Server` | library folders |
| cloudflared | service | `C:\ProgramData\cloudflared\token` | none |

Current paths. The **library** lives on `M:`; **downloads live on their own drive `I:`**
(see "Why downloads are on their own drive" below):

```
Sonarr root       C:\Users\lewih\Downloads\Media\TV        -> M:\Media\TV
Radarr root       C:\Users\lewih\Downloads\Media\Movies    -> M:\Media\Movies
qBittorrent temp  (incomplete downloads)                   -> I:\Incomplete
qBittorrent save  C:\Users\lewih\Downloads\Media\Incoming  -> I:\Incoming
  categories tv-sonarr / movies-radarr / other            -> I:\Incoming\{tv,movies,other}
raw grabs                          ...\Media\Other         -> M:\Media\Other
scripts                            ...\Media\App           -> M:\Media\App
```

## Why downloads are on their own drive

Downloads go to a dedicated 512 GB USB NVMe (`I:`), not the library drive and not `C:`.
Two reasons, both learned the hard way:

- **The 4 TB library drive is a USB HDD.** Torrents write scattered random pieces, which
  thrash a spinning USB disk down to 25–50 KB/s. The NVMe absorbs those random writes at
  full speed; completed files are then copied to `M:` as one sequential write, which the
  HDD handles fine.
- **`C:` is only 256 GB.** A single UHD remux is 55–85 GB, so a couple of concurrent grabs
  fill the system drive and every download errors out. The 512 GB NVMe holds three at once.

qBittorrent layout on `I:`:

```
Incomplete (temp)    I:\Incomplete
Completed            I:\Incoming\{tv,movies,other}   (per category)
Max active downloads 3
Share ratio limit    0, action = pause   (Sonarr/Radarr delete the original after import)
```

Because downloads (`I:`) and the library (`M:`) are different volumes, import is a copy,
not a hardlink. That is fine here: the sequential copy is fast, and the ratio-0 limit means
qBittorrent stops seeding the instant a torrent completes, so Sonarr/Radarr remove the `I:`
copy right after importing and nothing lingers on the download drive.

**Do not move in-progress torrents between drives** with qBittorrent's "Set location". On
this USB NTFS it de-sparsifies the file (writes the full size as zeros), bloating the
destination. If a download is on the wrong drive, scrap it and re-grab — it costs only the
few percent already downloaded. Note too that qBittorrent tracks the *incomplete* path
separately from the save path; changing one does not move the other.

## Order matters

Do it in this order. Several steps depend on the one before.

### 1. On the laptop, before you unplug anything

Take backups of the three arr apps. Each writes a zip to its own `Backups\manual` folder.
Settings, General, Backup, Backup Now in each UI, or from PowerShell:

```powershell
$apps = @{ Sonarr=8989; Radarr=7878; Prowlarr=9696 }
foreach ($a in $apps.GetEnumerator()) {
  $cfg = "C:\ProgramData\$($a.Key)\config.xml"
  $v = if ($a.Key -eq 'Prowlarr') { 'v1' } else { 'v3' }
  $h = @{ 'X-Api-Key' = ([xml](Get-Content $cfg)).Config.ApiKey; 'Content-Type' = 'application/json' }
  Invoke-RestMethod "http://localhost:$($a.Value)/api/$v/command" -Headers $h -Method Post -Body '{"name":"Backup"}' | Out-Null
  "$($a.Key): backup queued"
}
```

Copy those zips, plus `%APPDATA%\qBittorrent\qBittorrent.ini`, onto the USB drive so they
travel with the library.

**These backups carry the API keys**, because `config.xml` is inside them. That is why the
Worker's `SONARR_API_KEY`, `RADARR_API_KEY` and `PROWLARR_API_KEY` secrets stay valid and
never need re-entering. Verify it after the restore rather than assuming.

Finish the library copy, then run this to catch anything that changed while you were
copying. It only moves what is new.

**`Incoming` is deliberately excluded.** Its files are hardlinks of the ones already in
`TV`, so they cost nothing on the source drive, but robocopy does not preserve hardlinks
and writes them as full second copies. That is where 30 GB of duplicate went on the first
attempt, and qBittorrent recreates the folder on the new machine anyway:

```powershell
robocopy "C:\Users\lewih\Downloads\Media" "M:\Media" /E /J /R:1 /W:2 /TEE /XD "C:\Users\lewih\Downloads\Media\Incoming" /LOG:"M:\copy.log"
```

### 2. Prepare the Mini PC

Windows updates first, so it does not decide to reboot mid-migration.

Plug the drive in and **make sure it gets `M:`**. Every path below assumes it. From an
**elevated** PowerShell, checking the disk number first because it is not always 1:

```powershell
Get-Disk | Where-Object BusType -eq 'USB' | Select-Object Number, FriendlyName, @{n='SizeGB';e={[math]::Round($_.Size/1GB)}}
Set-Partition -DiskNumber 1 -PartitionNumber 1 -NewDriveLetter M
```

Power settings, because the drive is USB and mostly idle:

```
Power Options -> Change plan settings -> Advanced
  Hard disk -> Turn off hard disk after   = Never
  USB settings -> USB selective suspend   = Disabled
  Sleep -> Sleep after                    = Never
```

That last one matters more than the others. A media server that sleeps is a media server
that is offline, which is the problem you are moving away from.

### 3. Install, matching versions

```powershell
winget install MoritzBunkus.MKVToolNix
winget install TeamSonarr.Sonarr
winget install TeamRadarr.Radarr
winget install TeamProwlarr.Prowlarr
winget install qBittorrent.qBittorrent
winget install Plex.PlexMediaServer
```

Install cloudflared last, in step 6.

Start each arr app once so it creates its data folder, then **stop the service** before
restoring, or the restore will be overwritten when it shuts down.

### 4. Restore the arr apps

In each UI: System, Backup, Restore Backup, pick the zip. It restarts itself.

Then fix the paths, which the restore cannot know about:

- **Sonarr**: Settings, Media Management, Root Folders. Remove the `C:\Users\...` entry,
  add `M:\Media\TV`. Then Series, select all, Mass Editor, set root folder, so existing
  series point at the new path rather than showing as missing.
- **Radarr**: the same with `M:\Media\Movies`.
- **Both, important**: the *only* root folder should be the library path (`M:\Media\TV` /
  `M:\Media\Movies`). Never add the download folder (`I:\Incoming\...`) as a root folder —
  it makes the app "import" in place on the download drive instead of moving to the library,
  and triggers a "downloads in a root folder" health warning. Also clear any **Remote Path
  Mappings** (Settings, Download Clients); an all-local setup needs none.
- **Both**: Settings, Connect, the "English audio default" custom script. Change its path
  to `M:\Media\App\Set-EnglishAudio.ps1`.
- **Both**: Settings, Download Clients, qBittorrent. Confirm host `localhost`, port 8080,
  and that **Remove Completed Downloads is on**.

Check `AllowedHosts` survived the restore, because Sonarr and Radarr reject unknown Host
headers with "Bad Request - Invalid Hostname":

```powershell
foreach ($a in 'Sonarr','Radarr') { "$a : $(([xml](Get-Content "C:\ProgramData\$a\config.xml")).Config.AllowedHosts)" }
```

Sonarr wants `localhost,sonarr-api.ephix.net` and Radarr `localhost,radarr-api.ephix.net`.
If you edit that file, restart the **service**. The in-app restart is a no-op when it runs
as a service.

### 5. qBittorrent and the scripts

Copy `qBittorrent.ini` into `%APPDATA%\qBittorrent` with qBittorrent closed, then start it
and set the **temp (incomplete) path to `I:\Incomplete`** and the **default save path to
`I:\Incoming`**. Categories `tv-sonarr`, `movies-radarr` and `other` should come across with
the ini; confirm their save paths are `I:\Incoming\tv`, `I:\Incoming\movies` and
`I:\Incoming\other`. Set **max active downloads to 3** and the **global share-ratio limit to
0 with action = pause** (Options, BitTorrent), so completed torrents stop immediately and
the arr apps delete the original after importing.

Web UI, Options, Web UI: **server domains must be `localhost;qbit-api.ephix.net`**, with a
**semicolon**. A comma creates one bogus domain and locks out everything including Sonarr
and Radarr until you stop qBittorrent and fix the ini by hand.

The arr apps run as `NT AUTHORITY\LOCAL SERVICE`, which cannot read arbitrary folders. The
custom script will fail with "File does not exist" even though the file is plainly there.
Check and grant:

```powershell
(Get-Acl 'M:\Media\App').Access | Where-Object { $_.IdentityReference -match 'LOCAL SERVICE' }
icacls "M:\Media\App" /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)(RX)"
```

### 6. cloudflared

Install it on the Mini PC with the **same tunnel token**, which is on the drive at
`M:\Media\App\cloudflare tunnel key.txt`. The tunnel then has two connectors and traffic
splits between them, which is fine and briefly useful for testing.

Nothing in the Cloudflare dashboard changes. The ingress rules still say
`localhost:8989` and so on, and those ports are the same on the new machine.

Once the Mini PC is serving properly, **uninstall cloudflared from the laptop** so the old
connector stops accepting traffic. Until you do, roughly half of requests go to a machine
with no library on it.

### 7. Plex

Fresh install rather than a migration. The library database was 6 MB, so there is almost
nothing to preserve. Add three libraries:

```
Films         M:\Media\Movies
TV Programmes M:\Media\TV
Other videos  M:\Media\Other
```

Claim the server to your account when it asks. Afterwards remove the laptop's server under
Settings, otherwise you will have two listed and clients will pick the wrong one.

## Verifying, in order of how conclusive it is

1. `http://localhost:8989` and `:7878` on the Mini PC show your library, not an empty one
2. The cron probe: `wrangler tail`, wait up to five minutes, expect
   `probe sonarr via service token: 200`
3. `https://download.ephix.net` loads, search works, the queue is not showing offline
4. Zero Trust, Service Tokens, your token, **Last Seen** shows a recent time
5. Add something small and watch it grab, import, and push a notification
6. Play a 4K file and confirm `directplay` in the Plex session

## Do not delete the laptop's copy yet

Keep `C:\Users\lewih\Downloads\Media` until the Mini PC has run for a week without
complaint. The USB drive is a mechanical portable drive of unknown age and it will be the
only copy once you wipe the laptop. The laptop has the space, so it costs nothing to wait.

## What does not change

- Cloudflare tunnel, hostnames, Access application, policies, service token
- The Worker, its code, its vars and its secrets
- The ntfy topic and both notification connections
- Quality profiles, custom formats, indexers, all carried in the backups
