$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath "ucpa.db")) {
  throw "ucpa.db was not found in the repository root."
}
if (-not (git remote get-url origin 2>$null)) {
  throw "Git remote 'origin' is not configured yet. Create the GitHub repository and push the code first."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ucpa-data-" + [guid]::NewGuid().ToString("N"))
try {
  git worktree add --detach $temp HEAD
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary data worktree." }
  Push-Location $temp
  git switch --orphan data
  git rm -rf .
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\ucpa.db") -Destination "ucpa.db"
  git add -f ucpa.db
  git -c user.name="ucpa-data" -c user.email="ucpa-data@users.noreply.github.com" commit -m "bootstrap scraper database"
  git push --force origin HEAD:data
  if ($LASTEXITCODE -ne 0) { throw "Could not push the data branch." }
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  git worktree remove --force $temp 2>$null
}

Write-Host "The data branch now contains the current ucpa.db history."
