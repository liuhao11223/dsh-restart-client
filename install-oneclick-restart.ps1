<#
  One-click install of dsh-restart-client into the DSH Desktop *web* profile.

  1. copy the package files into  $DSH_HOME/profiles/web/node_modules/dsh-restart-client
  2. add an `insert` entry to    $DSH_HOME/profiles/web/cordis.patch.yml

  Files are fetched from the CDN build of this repository (see $base) and verified
  against the Git blob SHA-1 recorded here, so a tampered or truncated download
  aborts the install instead of half-installing.

  Idempotent: safe to re-run. Refresh the SHA-1 table whenever a release changes
  (git hash-object <file>).
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$harnessHome = Join-Path $env:APPDATA 'dsh-desktop\harness'
$profileDir  = Join-Path $harnessHome 'profiles\web'
$dest        = Join-Path $profileDir 'node_modules\dsh-restart-client'
$patchPath   = Join-Path $profileDir 'cordis.patch.yml'
# Published on jsDelivr from this repo's main branch.
$base        = 'https://cdn.jsdelivr.net/gh/liuhao11223/dsh-restart-client@main'

# Git blob SHA-1 of each released file (git hash-object). Regenerate after a release.
# These are the LF-normalized blobs actually served by the CDN.
$expected = @{
  'package.json'     = '633620ac0691d367da08eba18ae01b822a64c351'
  'README.md'        = '00e89e40f237d0f3c7f327b01ec39b7e854fe4b5'
  'LICENSE'          = 'aed179ed3fa2cf5577bc3f6e4f227b542678c4b7'
  'icon.svg'         = 'a731baba0373d36fb38468d3d7c94beb04c993b0'
  'cordis.patch.yml' = 'dde9b65956120c110f158c43e7a41cd5d874f9e1'
  'index.js'         = '31d3ee05a16cfb1c53f73cbe1556cc9d3ed54e72'
  'client.js'        = '1d9ffe1434e0d0cb44cb51acb1923a5e5b1b6522'
  'locale/zh.json'   = '1e036bcba09711a080ac77ea5f4de6d5e954a260'
  'locale/en.json'   = 'a9aa3bf4fbc554d4063a365efa92d8b220cec8ad'
}

function Get-GitBlobSha1([string]$Path) {
  $bytes  = [System.IO.File]::ReadAllBytes($Path)
  $header = [System.Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
  $all    = New-Object byte[] ($header.Length + $bytes.Length)
  [Array]::Copy($header, 0, $all, 0, $header.Length)
  [Array]::Copy($bytes, 0, $all, $header.Length, $bytes.Length)
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try { ($sha1.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha1.Dispose() }
}

Write-Host "profile : $profileDir"
Write-Host "target  : $dest"

# ---- 1. write access to the target (this is the sandbox boundary) ----------
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'locale') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dest '.write-probe'), 'ok', [System.Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath (Join-Path $dest '.write-probe') -Force
Write-Host "write probe: OK"

# ---- 2. fetch the package files -------------------------------------------
foreach ($rel in $expected.Keys) {
  $target = Join-Path $dest ($rel -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Invoke-WebRequest -Uri "$base/$rel" -OutFile $target -TimeoutSec 90 -UseBasicParsing
  $actual = Get-GitBlobSha1 $target
  $status = if ($actual -eq $expected[$rel]) { 'sha1 OK' } else { "sha1 MISMATCH (want $($expected[$rel]))" }
  Write-Host ("  {0,-18} {1,7} bytes  {2}" -f $rel, (Get-Item $target).Length, $status)
  if ($actual -ne $expected[$rel]) { throw "integrity check failed for $rel" }
}

# ---- 3. mount it in the profile patch layer -------------------------------
$patch = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
if ($patch -match 'dsh-restart-client') {
  Write-Host "cordis.patch.yml: entry already present"
} else {
  $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = "$patchPath.bak-$stamp"
  Copy-Item -LiteralPath $patchPath -Destination $backup -Force
  if (-not $patch.EndsWith("`n")) { $patch += "`n" }
  $patch += "# dsh-restart-client (installer)`n- insert:`n    - id: dsh-restart-client`n      name: dsh-restart-client`n"
  [System.IO.File]::WriteAllText($patchPath, $patch, [System.Text.UTF8Encoding]::new($false))
  Write-Host "cordis.patch.yml: insert added (backup: $backup)"
}

Write-Host ""
Write-Host "installed files:"
Get-ChildItem -LiteralPath $dest -Recurse -File | ForEach-Object {
  Write-Host ("  {0}  ({1} bytes)" -f $_.FullName.Substring($dest.Length + 1), $_.Length)
}
Write-Host ""
Write-Host "--- cordis.patch.yml ---"
Get-Content -LiteralPath $patchPath