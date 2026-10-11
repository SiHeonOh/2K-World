# Makes "2K World" shortcuts on the desktop and in the Start menu that open the built app
# from this folder (run `npm run build` first; after that, each new build shows up the next
# time it's opened). League data stays in this folder's league-data/.
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'resources\icon.ico'
$main = Join-Path $root 'out\main\index.js'
if (-not (Test-Path $electron)) { throw "Electron isn't installed here: run npm install first." }
if (-not (Test-Path $main)) { throw "The app isn't built yet: run npm run build first." }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
  $link = $shell.CreateShortcut((Join-Path $dir '2K World.lnk'))
  $link.TargetPath = $electron
  $link.Arguments = '"' + $root + '"'
  $link.WorkingDirectory = $root
  $link.IconLocation = "$icon,0"
  $link.Description = '2K World'
  $link.Save()
  Write-Output "made $(Join-Path $dir '2K World.lnk')"
}
