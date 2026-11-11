# fetch-qemu-win.ps1 -- get QEMU for Windows (64-bit) for a gamec Steam build, with the matching source archive (GPL-2.0).
# Run on a Windows PC with internet, in PowerShell:
#     powershell -ExecutionPolicy Bypass -File fetch-qemu-win.ps1 [-Out C:\qemu-for-steam] [-Installer <url of a qemu-w64-setup-*.exe>]
# Then on the build machine:  node Backend/tools/gamec.mjs steam <game> <bundle> --qemu-win <that folder>
# (or set QEMU_WIN=<folder> for ThirdTemple's tools/make_dist.sh --steam).
# The installer is Stefan Weil's QEMU for Windows build (https://qemu.weilnetz.de/w64/), the one qemu.org links to.
# It is unpacked by its own silent install into -Out, not installed system-wide (no registry, no PATH change).
param(
  [string]$Out = "$PWD\qemu-win",
  [string]$Installer = ""
)
$ErrorActionPreference = "Stop"
$base = "https://qemu.weilnetz.de/w64/"
if (-not $Installer) {
  # the newest qemu-w64-setup-YYYYMMDD.exe in the listing (and in its yearly sub-folders)
  $page = (Invoke-WebRequest -UseBasicParsing $base).Content
  $names = [regex]::Matches($page, 'qemu-w64-setup-(\d{8})\.exe') | ForEach-Object { $_.Value } | Sort-Object -Unique
  if (-not $names) {
    $years = [regex]::Matches($page, 'href="(20\d\d)/"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Descending
    foreach ($y in $years) {
      $sub = (Invoke-WebRequest -UseBasicParsing "$base$y/").Content
      $names = [regex]::Matches($sub, 'qemu-w64-setup-(\d{8})\.exe') | ForEach-Object { $_.Value } | Sort-Object -Unique
      if ($names) { $base = "$base$y/"; break }
    }
  }
  if (-not $names) { throw "No qemu-w64-setup-*.exe found at $base; pass -Installer <url>." }
  $Installer = $base + ($names | Select-Object -Last 1)
}
$tmp = Join-Path $env:TEMP ([IO.Path]::GetFileName($Installer))
Write-Host "Downloading $Installer"
Invoke-WebRequest -UseBasicParsing $Installer -OutFile $tmp
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Host "Unpacking into $Out"
Start-Process -FilePath $tmp -ArgumentList "/S", "/D=$Out" -Wait   # NSIS: /D must be last and unquoted
if (-not (Test-Path "$Out\qemu-system-x86_64.exe")) { throw "qemu-system-x86_64.exe not found in $Out after unpacking." }
# keep only what the game needs: the x86_64 system emulator, its DLLs, firmware, keymaps, licences (saves ~700 MB)
Get-ChildItem $Out -Filter "qemu-system-*.exe" | Where-Object { $_.Name -notmatch '^qemu-system-x86_64w?\.exe$' } | Remove-Item -Force
Get-ChildItem $Out -Filter "qemu-*.exe" | Where-Object { $_.Name -notmatch '^qemu-system-x86_64w?\.exe$' } | Remove-Item -Force
Remove-Item -Force -ErrorAction SilentlyContinue "$Out\uninstall.exe"
$ver = (& "$Out\qemu-system-x86_64.exe" --version | Select-Object -First 1)
Write-Host $ver
if ($ver -match 'version (\d+\.\d+\.\d+)') {
  $v = $Matches[1]
  $src = "https://download.qemu.org/qemu-$v.tar.xz"
  Write-Host "Downloading the matching source $src"
  Invoke-WebRequest -UseBasicParsing $src -OutFile "$Out\qemu-$v.tar.xz"
  @"
QEMU for Windows, shipped unmodified with this game so that it runs without installing anything.

$ver
Binary: $Installer  (Stefan Weil's Windows build, linked from qemu.org)
QEMU is free software under the GNU General Public License version 2 (see COPYING / LICENSE in this folder).
Source: qemu-$v.tar.xz in this folder (from $src).  The Windows build's own scripts are at
https://qemu.weilnetz.de/ and in that source tree.  Libraries (DLLs) are under their own licences.
"@ | Set-Content -Encoding UTF8 "$Out\QEMU-SOURCE.txt"
}
Write-Host "Done: $Out"
