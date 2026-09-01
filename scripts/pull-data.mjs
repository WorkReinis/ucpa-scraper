// Safely update a local ucpa.db from the rolling data branch.
//
// The remote candidate is extracted and validated before the working copy is
// touched. A local DB is checkpointed, compared by latest scrape timestamp,
// and moved to a timestamped backup before replacement. If installation of
// the candidate fails, the backup is restored.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB = "ucpa.db";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export function compareLatestRuns(localRun, remoteRun) {
  if (!remoteRun) throw new Error("remote database has no completed scrape run");
  if (!localRun) return "remote-newer";
  const localTime = Date.parse(localRun.started_at);
  const remoteTime = Date.parse(remoteRun.started_at);
  if (!Number.isFinite(localTime) || !Number.isFinite(remoteTime)) {
    throw new Error("database contains an invalid latest-run timestamp");
  }
  if (remoteTime > localTime) return "remote-newer";
  if (remoteTime < localTime) return "local-newer";
  return "same";
}

export function inspectDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`${dbPath}: integrity_check returned ${integrity}`);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`${dbPath}: ${foreignKeys.length} foreign-key violation(s)`);
    const latestRun = db.prepare(
      "SELECT id, started_at, n_products FROM run WHERE n_products IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get();
    return latestRun ? { ...latestRun } : null;
  } finally {
    db.close();
  }
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "git command failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function checkpointLocalDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result.busy !== 0) {
      throw new Error("local database is busy; stop the server before pulling data");
    }
  } finally {
    db.close();
  }
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("local WAL still contains data; stop writers and retry");
  }
  // With no live writer and a fully truncated WAL, these are disposable
  // coordination files belonging to the old database image. Removing them
  // prevents a stale SHM from accompanying the newly installed database.
  for (const sidecar of [walPath, `${dbPath}-shm`]) {
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }
}

function backupPathFor(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dbPath}.bak-data-pull-${stamp}`;
}

export function pullData({ cwd = process.cwd(), dbFile = DEFAULT_DB } = {}) {
  const dbPath = path.resolve(cwd, dbFile);
  const candidatePath = `${dbPath}.pull-${process.pid}-${Date.now()}.tmp`;
  let backupPath = null;

  try {
    console.log("Fetching origin/data...");
    runGit(["fetch", "origin", "data"], { cwd });
    const blob = runGit(["show", "origin/data:ucpa.db"], { cwd, encoding: null }).stdout;
    if (!Buffer.isBuffer(blob) || blob.length === 0) {
      throw new Error("origin/data:ucpa.db was empty");
    }
    fs.writeFileSync(candidatePath, blob, { flag: "wx" });

    const remoteRun = inspectDatabase(candidatePath);
    let localRun = null;
    if (fs.existsSync(dbPath)) {
      checkpointLocalDatabase(dbPath);
      localRun = inspectDatabase(dbPath);
    }

    const decision = compareLatestRuns(localRun, remoteRun);
    if (decision === "same") {
      console.log(`Already current at run #${remoteRun.id} (${remoteRun.started_at}).`);
      return { status: "current", localRun, remoteRun, backupPath: null };
    }
    if (decision === "local-newer") {
      throw new Error(
        `refusing to replace newer local run #${localRun.id} (${localRun.started_at}) ` +
        `with remote run #${remoteRun.id} (${remoteRun.started_at})`
      );
    }

    if (fs.existsSync(dbPath)) {
      backupPath = backupPathFor(dbPath);
      fs.renameSync(dbPath, backupPath);
    }
    try {
      fs.renameSync(candidatePath, dbPath);
    } catch (error) {
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(dbPath)) {
        fs.renameSync(backupPath, dbPath);
      }
      throw error;
    }

    console.log(
      `Installed remote run #${remoteRun.id} (${remoteRun.started_at}, ${remoteRun.n_products} products).`
    );
    if (backupPath) console.log(`Previous database: ${backupPath}`);
    return { status: "updated", localRun, remoteRun, backupPath };
  } finally {
    for (const file of [candidatePath, `${candidatePath}-shm`, `${candidatePath}-wal`]) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    pullData({ dbFile: process.argv[2] || DEFAULT_DB });
  } catch (error) {
    console.error(`data pull failed: ${error.message}`);
    process.exitCode = 1;
  }
}
