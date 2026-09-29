<#
.SYNOPSIS
  Add a show to Sonarr or a film to Radarr. They search + download + rename from there.

.EXAMPLE
  .\Add-Title.ps1 -Show "Slow Horses"           # all seasons, searches immediately
  .\Add-Title.ps1 -Show "Slow Horses" -Season 5 # only season 5 (earlier ones unmonitored)
  .\Add-Title.ps1 -Show "Slow Horses" -FutureOnly
  .\Add-Title.ps1 -Movie "Heat" -Year 1995
  .\Add-Title.ps1 -Show "Sugar" -TvdbId 421070  # when the name is ambiguous
#>
[CmdletBinding(DefaultParameterSetName = 'Show')]
param(
    [Parameter(ParameterSetName = 'Show', Mandatory)]  [string] $Show,
    [Parameter(ParameterSetName = 'Movie', Mandatory)] [string] $Movie,
    [int]    $Year,
    [int]    $TvdbId,
    [int]    $TmdbId,
    [int]    $Season,        # Show only: monitor just this season
    [switch] $FutureOnly,    # Show only: monitor future episodes only
    [ValidateSet('HD-1080p', 'Ultra-HD', 'HD-720p', 'Any')] [string] $Quality = 'HD-1080p'
)
$ErrorActionPreference = 'Stop'
function Key($app) { ([xml](Get-Content "C:\ProgramData\$app\config.xml")).Config.ApiKey }

if ($PSCmdlet.ParameterSetName -eq 'Show') {
    $B = 'http://localhost:8989/api/v3'; $H = @{ 'X-Api-Key' = Key Sonarr; 'Content-Type' = 'application/json' }
    $term = if ($TvdbId) { "tvdb:$TvdbId" } else { $Show }
    $raw = Invoke-RestMethod "$B/series/lookup?term=$([uri]::EscapeDataString($term))" -Headers $H
    $hits = @($raw | ForEach-Object { $_ })
    if ($Year) { $hits = @($hits | Where-Object year -eq $Year) }
    if (-not $hits) { Write-Host "No match for '$Show'." -ForegroundColor Red; exit 2 }
    $s = $hits[0]
    if ($s.id) { Write-Host "Already in Sonarr: $($s.title) ($($s.year))" -ForegroundColor Yellow; exit 0 }
    if ($hits.Count -gt 1) {
        Write-Host "Picking first of $($hits.Count) matches - pass -Year or -TvdbId if wrong:" -ForegroundColor DarkYellow
        $hits | Select-Object -First 4 | ForEach-Object { "   tvdb $($_.tvdbId)  $($_.title) ($($_.year)) $($_.network)" }
    }
    $profiles = Invoke-RestMethod "$B/qualityprofile" -Headers $H
    $profile = ($profiles | Where-Object name -eq $Quality).id
    $monitor = if ($FutureOnly) { 'future' } else { 'all' }
    $seasons = $s.seasons
    if ($Season) {
        $monitor = 'none'
        foreach ($x in $seasons) { $x.monitored = ($x.seasonNumber -eq $Season) }
    }
    $folder = ($s.title -replace '\s*\(\d{4}\)$', '') -replace '[<>:"/\\|?*]', ''
    $body = @{
        tvdbId = $s.tvdbId; title = $s.title; titleSlug = $s.titleSlug; images = $s.images; seasons = $seasons
        path = "C:\Users\lewih\Downloads\Media\TV\$folder"; rootFolderPath = 'C:\Users\lewih\Downloads\Media\TV'
        qualityProfileId = $profile; seasonFolder = $true; monitored = $true; seriesType = 'standard'
        addOptions = @{ monitor = $monitor; searchForMissingEpisodes = $true; searchForCutoffUnmetEpisodes = $false }
    } | ConvertTo-Json -Depth 6
    $r = Invoke-RestMethod -Method Post "$B/series" -Headers $H -Body $body
    Write-Host "Added to Sonarr: $($r.title) ($($r.year)) -> TV\$folder  [monitor: $monitor$(if ($Season) { " season $Season" })]" -ForegroundColor Green
    Write-Host "Sonarr is searching now; watch http://localhost:8989/activity/queue"
}
else {
    $B = 'http://localhost:7878/api/v3'; $H = @{ 'X-Api-Key' = Key Radarr; 'Content-Type' = 'application/json' }
    $term = if ($TmdbId) { "tmdb:$TmdbId" } else { $Movie }
    $raw = Invoke-RestMethod "$B/movie/lookup?term=$([uri]::EscapeDataString($term))" -Headers $H
    $hits = @($raw | ForEach-Object { $_ })
    if ($Year) { $hits = @($hits | Where-Object year -eq $Year) }
    if (-not $hits) { Write-Host "No match for '$Movie'." -ForegroundColor Red; exit 2 }
    $m = $hits[0]
    if ($m.id) { Write-Host "Already in Radarr: $($m.title) ($($m.year))" -ForegroundColor Yellow; exit 0 }
    if ($hits.Count -gt 1) {
        Write-Host "Picking first of $($hits.Count) matches - pass -Year or -TmdbId if wrong:" -ForegroundColor DarkYellow
        $hits | Select-Object -First 4 | ForEach-Object { "   tmdb $($_.tmdbId)  $($_.title) ($($_.year))" }
    }
    $profiles = Invoke-RestMethod "$B/qualityprofile" -Headers $H
    $profile = ($profiles | Where-Object name -eq $Quality).id
    $folder = "$($m.title) ($($m.year))" -replace '[<>:"/\\|?*]', ''
    $body = @{
        tmdbId = $m.tmdbId; title = $m.title; year = $m.year; titleSlug = $m.titleSlug; images = $m.images
        path = "C:\Users\lewih\Downloads\Media\Movies\$folder"; rootFolderPath = 'C:\Users\lewih\Downloads\Media\Movies'
        qualityProfileId = $profile; monitored = $true; minimumAvailability = 'released'
        addOptions = @{ searchForMovie = $true; monitor = 'movieOnly' }
    } | ConvertTo-Json -Depth 6
    $r = Invoke-RestMethod -Method Post "$B/movie" -Headers $H -Body $body
    Write-Host "Added to Radarr: $($r.title) ($($r.year)) -> Movies\$folder" -ForegroundColor Green
    Write-Host "Radarr is searching now; watch http://localhost:7878/activity/queue"
}
