<#
.SYNOPSIS
  Make the English audio track the default in an .mkv, so players pick it automatically.

  Runs standalone on a file/folder, or as a Sonarr/Radarr "Custom Script" connection on
  import (they pass the file path in an environment variable). Metadata-only edit via
  mkvpropedit - no re-encode, takes about a second.

.EXAMPLE
  .\Set-EnglishAudio.ps1 "C:\Users\lewih\Downloads\Media\Movies\Carlito's Way (1993)\Carlito's Way (1993).mkv"
  .\Set-EnglishAudio.ps1 "C:\Users\lewih\Downloads\Media\TV" -Recurse   # fix everything
#>
param(
    [string] $Path,
    [switch] $Recurse
)
$ErrorActionPreference = 'Stop'
$log = "C:\Users\lewih\Downloads\Media\App\Set-EnglishAudio.log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $log; Write-Host $m }

# Called by Sonarr / Radarr: only act on imports, path comes from their env vars.
if (-not $Path) {
    $evt = if ($env:sonarr_eventtype) { $env:sonarr_eventtype } else { $env:radarr_eventtype }
    if ($evt -eq 'Test') { Log "test event OK"; exit 0 }
    if ($evt -notin @('Download', 'Import', 'Upgrade')) { exit 0 }
    $Path = if ($env:sonarr_episodefile_path) { $env:sonarr_episodefile_path } else { $env:radarr_moviefile_path }
    if (-not $Path) { Log "no file path in event $evt"; exit 0 }
}

$mkvpropedit = @(
    'C:\Program Files\MKVToolNix\mkvpropedit.exe',
    "$env:LOCALAPPDATA\Programs\MKVToolNix\mkvpropedit.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$mkvmerge = $mkvpropedit -replace 'mkvpropedit\.exe$', 'mkvmerge.exe'
if (-not $mkvpropedit) { Log "mkvpropedit not found - install MKVToolNix"; exit 1 }

# -LiteralPath throughout: release names routinely contain [brackets], which -Path would
# treat as wildcards and silently match nothing. Sonarr/Radarr rename before firing this,
# so imports are already clean, but a manual sweep over Other\ would hit it.
$item = Get-Item -LiteralPath $Path
$files = if ($item.PSIsContainer) {
    Get-ChildItem -LiteralPath $Path -Filter *.mkv -Recurse:$Recurse -File
} else { $item }

foreach ($f in $files) {
    if ($f.Extension -ne '.mkv') { Log "skip (not mkv): $($f.Name)"; continue }
    $info = & $mkvmerge -J $f.FullName | ConvertFrom-Json
    $audio = @($info.tracks | Where-Object type -eq 'audio')
    if ($audio.Count -lt 2) { continue }   # nothing to choose between
    $langOf = { param($t) $l = $t.properties.language_ietf; if (-not $l) { $l = $t.properties.language }; if (-not $l) { $l = 'und' }; $l.ToLower() }
    $eng = $audio | Where-Object { (& $langOf $_) -match '^en' } | Select-Object -First 1
    if (-not $eng) { Log "no English audio track: $($f.Name) [$(($audio | ForEach-Object { & $langOf $_ }) -join '/')]"; continue }
    $defaultNow = $audio | Where-Object { $_.properties.default_track } | Select-Object -First 1
    if ($defaultNow -and $defaultNow.id -eq $eng.id) { continue }   # already right

    # mkvpropedit addresses tracks as "track:a1", "track:a2" ... (1-based within audio tracks)
    $mkArgs = @($f.FullName)
    for ($i = 0; $i -lt $audio.Count; $i++) {
        $flag = if ($audio[$i].id -eq $eng.id) { 1 } else { 0 }
        $mkArgs += '--edit', "track:a$($i + 1)", '--set', "flag-default=$flag"
    }
    & $mkvpropedit @mkArgs | Out-Null
    if ($LASTEXITCODE -le 1) { Log "English set as default: $($f.Name) [$(($audio | ForEach-Object { & $langOf $_ }) -join '/')]" }
    else { Log "mkvpropedit failed ($LASTEXITCODE): $($f.FullName)" }
}
