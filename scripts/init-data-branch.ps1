$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath "ucpa.db")) {
  throw "ucpa.db was not found in the repository root."
}
$databasePath = (Resolve-Path -LiteralPath "ucpa.db").Path
node src/checkpoint-db.mjs $databasePath
if ($LASTEXITCODE -ne 0) { throw "Could not checkpoint the SQLite WAL before copying." }
$databaseHash = (Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash
if (-not (git remote get-url origin 2>$null)) {
  throw "Git remote 'origin' is not configured yet. Create the GitHub repository and push the code first."
}

# This script is one-time bootstrap only, for a repository that has never
# had a data branch. It orphan-force-pushes unconditionally, which is
# exactly the pattern that once let a stale local ucpa.db silently clobber
# newer scrapes already published by CI. Refuse to run it again once the
# branch exists -- from that point on, publishing happens only through the
# "Refresh UCPA catalogue" workflow's fetch/commit/push (no --force).
git ls-remote --exit-code --heads origin data | Out-Null
if ($LASTEXITCODE -eq 0) {
  throw "The 'data' branch already exists on origin. This script is one-time bootstrap only -- publishing after that point happens through the 'Refresh UCPA catalogue' workflow. If you really need to reseed it deliberately, fetch and reconcile origin/data first, then push (without --force) by hand."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ucpa-data-" + [guid]::NewGuid().ToString("N"))
$tempBranch = "data-bootstrap-" + [guid]::NewGuid().ToString("N")
try {
  git worktree add --detach $temp HEAD
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary data worktree." }
  Push-Location $temp
  git switch --orphan $tempBranch
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary orphan branch." }
  $trackedFiles = @(git ls-files)
  if ($trackedFiles.Count -gt 0) { git rm -rf -- . }
  Copy-Item -LiteralPath $databasePath -Destination "ucpa.db"
  $copiedHash = (Get-FileHash -LiteralPath "ucpa.db" -Algorithm SHA256).Hash
  if ($copiedHash -ne $databaseHash) { throw "The copied database failed its SHA256 verification." }
  git add -f ucpa.db
  git -c user.name="ucpa-data" -c user.email="ucpa-data@users.noreply.github.com" commit -m "bootstrap scraper database"
  git push --force origin HEAD:data
  if ($LASTEXITCODE -ne 0) { throw "Could not push the data branch." }
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  git worktree remove --force $temp 2>$null
  git branch -D $tempBranch 2>$null
}

Write-Host "The data branch now contains the current ucpa.db history."
