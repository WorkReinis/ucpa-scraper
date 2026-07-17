import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] || "ucpa.db";
const db = new DatabaseSync(path);
try {
  const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (result.busy !== 0) throw new Error(`SQLite WAL checkpoint is busy (${result.busy})`);
  console.log(`checkpointed ${path}`);
} finally {
  db.close();
}
