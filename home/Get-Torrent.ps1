<#
.SYNOPSIS
  Search qBittorrent's built-in search plugins and add the best result.

.EXAMPLE
  .\Get-Torrent.ps1 "Reacher S04E09"
  .\Get-Torrent.ps1 "The Pitt S02E01" -List
  .\Get-Torrent.ps1 "Heat 1995" -Quality 2160p -MinSeeders 20

.NOTES
  Needs qBittorrent Web UI on (Tools > Options > Web UI) with
  "Bypass authentication for clients on localhost" ticked. See README.md.
#>
param(
    [Parameter(Mandatory, Position = 0)] [string] $Query,
    [ValidateSet('1080p', '2160p', '720p', 'any')] [string] $Quality = '1080p',
    [int]    $MinSeeders = 5,
    [double] $MinGB = 0.3,      # fakes are usually tiny; a real 1080p episode is >0.5 GB
    [switch] $List,
    [switch] $DryRun,           # show results, add nothing
    [string] $SavePath = 'C:\Users\lewih\Downloads\Media\Incoming',
    [string] $Category = '',
    [string] $Url = 'http://localhost:8080'
)

$ErrorActionPreference = 'Stop'
$api = "$Url/api/v2"
# Search jobs are tied to the HTTP session, so every call must share one cookie jar
$ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession

try { $ver = Invoke-RestMethod "$api/app/version" -WebSession $ws }
catch {
    Write-Host "Cannot reach qBittorrent Web UI at $Url." -ForegroundColor Red
    Write-Host "Enable it: Tools > Options > Web UI, tick 'Bypass authentication for clients on localhost'."
    exit 1
}
Write-Host "qBittorrent $ver - searching for '$Query' ..." -ForegroundColor Cyan

# Kick off a search across every enabled plugin
$job = Invoke-RestMethod -Method Post "$api/search/start" -Body @{ pattern = $Query; plugins = 'enabled'; category = 'all' } -WebSession $ws
$id  = $job.id

# Plugins finish at different speeds; wait for all to stop (or 40 s, whichever first)
$deadline = (Get-Date).AddSeconds(40)
do {
    Start-Sleep -Seconds 2
    $status = @(Invoke-RestMethod "$api/search/status?id=$id" -WebSession $ws)
} while ($status[0].status -eq 'Running' -and (Get-Date) -lt $deadline)

$res = Invoke-RestMethod "$api/search/results?id=$id&limit=500" -WebSession $ws
Invoke-RestMethod -Method Post "$api/search/delete" -Body @{ id = $id } -WebSession $ws | Out-Null

$all = @($res.results)
if ($all.Count -eq 0) { Write-Host "No results."; exit 2 }

# Malware torrents on public trackers are named like "<Show> S01E01 1080p ... .exe" and are
# often the *most* seeded result. Reject anything whose name carries an executable/installer
# extension. (qBittorrent's excluded-file-names setting is the second line of defence.)
$badName = '\.(exe|scr|msi|com|bat|cmd|ps1|vbs|js|jar|hta|pif|lnk|zipx|iso|dmg|apk)(\b|$)'
$rejected = @($all | Where-Object { $_.fileName -match $badName })
if ($rejected.Count) {
    Write-Host "Rejected $($rejected.Count) result(s) with executable names:" -ForegroundColor Yellow
    $rejected | ForEach-Object { Write-Host "   x [$($_.nbSeeders) S] $($_.fileName)" -ForegroundColor DarkYellow }
}

# Filter: quality tag in the name, enough seeders, not suspiciously small. Then best-seeded first.
$hits = @($all | Where-Object {
    $_.fileName -notmatch $badName -and
    ($Quality -eq 'any' -or $_.fileName -match $Quality) -and
    $_.nbSeeders -ge $MinSeeders -and
    $_.fileSize -ge ($MinGB * 1GB)
} | Sort-Object nbSeeders -Descending)

if ($hits.Count -eq 0) {
    Write-Host "$($all.Count) results, none matching $Quality with >= $MinSeeders seeders and >= $MinGB GB. Try -Quality any or -MinSeeders 1."
    exit 2
}

$top = @($hits | Select-Object -First 10)
$i = 0
foreach ($t in $top) {
    $i++
    $gb = [math]::Round($t.fileSize / 1GB, 2)
    "{0,2}. [{1,5} S] {2,6} GB  {3}  ({4})" -f $i, $t.nbSeeders, $gb, $t.fileName, $t.engineName
}

if ($DryRun) { exit 0 }

if ($List) {
    $n = Read-Host "Add which? (1-$($top.Count), Enter to cancel)"
    if (-not $n) { exit 0 }
    $pick = $top[[int]$n - 1]
} else {
    $pick = $top[0]
}

$body = @{ urls = $pick.fileUrl; savepath = $SavePath }
if ($Category) { $body.category = $Category }
$r = Invoke-RestMethod -Method Post "$api/torrents/add" -Body $body -WebSession $ws
if ($r -eq 'Ok.') {
    Write-Host "Added: $($pick.fileName)" -ForegroundColor Green
    Write-Host "  -> $SavePath"
} else {
    Write-Host "qBittorrent replied: $r" -ForegroundColor Yellow
}
