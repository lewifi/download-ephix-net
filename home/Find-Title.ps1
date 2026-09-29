<#
.SYNOPSIS
  Look a title up: is it a show or a film, is it already in the library, what releases exist.

.EXAMPLE
  .\Find-Title.ps1 "The Pitt"                 # library status + TVDB/TMDB matches
  .\Find-Title.ps1 "The Pitt S02E01" -Releases # + what Prowlarr can find right now
#>
param(
    [Parameter(Mandatory, Position = 0)] [string] $Title,
    [switch] $Releases,
    [int]    $Top = 10
)
$ErrorActionPreference = 'Stop'
function Key($app) { ([xml](Get-Content "C:\ProgramData\$app\config.xml")).Config.ApiKey }
$Son = @{ Base = 'http://localhost:8989/api/v3'; H = @{ 'X-Api-Key' = Key Sonarr } }
$Rad = @{ Base = 'http://localhost:7878/api/v3'; H = @{ 'X-Api-Key' = Key Radarr } }
$Pro = @{ Base = 'http://localhost:9696/api/v1'; H = @{ 'X-Api-Key' = Key Prowlarr } }
$q = [uri]::EscapeDataString($Title)

# Strip an SxxEyy / year so the lookup sees just the name
$name = ($Title -replace '\bS\d{1,2}E\d{1,3}\b', '' -replace '\b(19|20)\d{2}\b', '').Trim()
$qn = [uri]::EscapeDataString($name)

Write-Host "TV (Sonarr / TVDB):" -ForegroundColor Cyan
$raw = Invoke-RestMethod "$($Son.Base)/series/lookup?term=$qn" -Headers $Son.H
$shows = @($raw | Select-Object -First 5)
foreach ($s in $shows) {
    $inLib = if ($s.id) { $st = (Invoke-RestMethod "$($Son.Base)/series/$($s.id)" -Headers $Son.H).statistics; "IN LIBRARY ($($st.episodeFileCount) files)" } else { '' }
    "  tvdb {0,-7} {1} ({2}) {3}  {4}" -f $s.tvdbId, $s.title, $s.year, $s.network, $inLib
}
if (-not $shows) { '  no matches' }

Write-Host "Film (Radarr / TMDB):" -ForegroundColor Cyan
$raw = Invoke-RestMethod "$($Rad.Base)/movie/lookup?term=$qn" -Headers $Rad.H
$films = @($raw | Select-Object -First 5)
foreach ($m in $films) {
    $inLib = if ($m.id) { if ($m.hasFile) { 'IN LIBRARY (has file)' } else { 'IN LIBRARY (wanted)' } } else { '' }
    "  tmdb {0,-7} {1} ({2})  {3}" -f $m.tmdbId, $m.title, $m.year, $inLib
}
if (-not $films) { '  no matches' }

if ($Releases) {
    Write-Host "Releases via Prowlarr for '$Title':" -ForegroundColor Cyan
    $raw = Invoke-RestMethod "$($Pro.Base)/search?query=$q&type=search&limit=200" -Headers $Pro.H
$r = @($raw | ForEach-Object { $_ })
    $bad = '\.(exe|scr|msi|bat|cmd|lnk|zipx|iso|apk)(\b|$)'
    $r | Where-Object { $_.title -notmatch $bad } | Sort-Object seeders -Descending | Select-Object -First $Top | ForEach-Object {
        "  [{0,5} S] {1,6:N2} GB  {2}  ({3})" -f $_.seeders, ($_.size / 1GB), $_.title, $_.indexer
    }
    $x = @($r | Where-Object { $_.title -match $bad })
    if ($x) { Write-Host "  (hid $($x.Count) executable-named result(s))" -ForegroundColor DarkYellow }
    if (-not $r) { '  nothing found' }
}
