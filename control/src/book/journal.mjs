import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export function journal(file, readOnly = false) {
  const dir = path.dirname(file);
  if (fs.realpathSync(dir) !== dir || fs.statSync(dir).mode & 0o077)
    throw Error("Private receiver directory required");
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()))
    throw Error("Regular receiver journal required");
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout=3000");
  if (!readOnly) {
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receiver_sessions(id TEXT PRIMARY KEY,request TEXT UNIQUE NOT NULL,task TEXT NOT NULL,creation TEXT NOT NULL,agent TEXT UNIQUE,cwd TEXT,phase TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,mode TEXT NOT NULL DEFAULT 'human',binding TEXT,native TEXT);
      CREATE TABLE IF NOT EXISTS receiver_intents(id TEXT PRIMARY KEY,session TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS receiver_results(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receiver_identity(id INTEGER PRIMARY KEY CHECK(id=1),controller TEXT NOT NULL,host TEXT NOT NULL);`);
  }
  return db;
}
export function atomic(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = fn();
    db.exec("COMMIT");
    return v;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
