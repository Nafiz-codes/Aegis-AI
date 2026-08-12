import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { childLogger } from "../logger.js";
import { loadConfig } from "../config.js";

const log = childLogger("store");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Legacy single-point location; nullable when the explicit
  -- subscribedLocations JSON list is used instead.
  lat REAL,
  lon REAL,
  subscribed_locations TEXT,
  subscribed_channels TEXT NOT NULL,
  contacts TEXT NOT NULL,
  preferences TEXT NOT NULL DEFAULT '{}',
  locale TEXT NOT NULL DEFAULT 'en',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  type TEXT NOT NULL,
  severity_level TEXT NOT NULL,
  severity_score REAL NOT NULL,
  confidence REAL NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location_name TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  affected_region TEXT,
  magnitude REAL,
  occurred_at TEXT NOT NULL,
  expected_at TEXT,
  observed_at TEXT NOT NULL,
  raw TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_observed_at ON events(observed_at);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  severity TEXT NOT NULL,
  composed TEXT NOT NULL,
  status TEXT NOT NULL,
  conversation_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_event ON alerts(event_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);

CREATE TABLE IF NOT EXISTS acks (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  response TEXT NOT NULL,
  raw_text TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (alert_id) REFERENCES alerts(id)
);

CREATE INDEX IF NOT EXISTS idx_acks_alert ON acks(alert_id);
`;

export class Store {
  private db: Database;
  private readonly dbPath: string;
  private dirty = false;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async open(dbPath: string = loadConfig().AEGIS_DB_PATH): Promise<Store> {
    const SQL = await loadSqlJs();
    let db: Database;
    try {
      const buf = await readFile(dbPath);
      db = new SQL.Database(new Uint8Array(buf));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        db = new SQL.Database();
      } else {
        throw err;
      }
    }
    db.exec(SCHEMA);
    const store = new Store(db, dbPath);
    log.info({ dbPath }, "store opened");
    return store;
  }

  /**
   * Run a function inside a transaction. The SQL.js driver has no auto-commit,
   * so we wrap mutation batches manually.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.dirty = true;
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Execute a write statement and return the number of rows changed. */
  exec(sql: string, params: SqlParam[] = []): number {
    const stmt = this.db.prepare(sql);
    try {
      stmt.run(params);
      this.dirty = true;
      return this.db.getRowsModified();
    } finally {
      stmt.free();
    }
  }

  /** Run a SELECT and map rows. */
  all<T>(sql: string, params: SqlParam[] = [], map: (row: Record<string, unknown>) => T): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const out: T[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        out.push(map(row));
      }
      return out;
    } finally {
      stmt.free();
    }
  }

  /** Run a SELECT and return the first row, or null. */
  first<T>(sql: string, params: SqlParam[] = [], map: (row: Record<string, unknown>) => T): T | null {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      if (stmt.step()) {
        return map(stmt.getAsObject() as Record<string, unknown>);
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  /** Persist the in-memory DB to disk. Call periodically or on shutdown. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    // In-memory databases (":memory:" or sql.js' transient mode) have no file.
    if (this.dbPath === ":memory:" || this.dbPath === "") {
      this.dirty = false;
      return;
    }
    const data = this.db.export();
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, Buffer.from(data));
    this.dirty = false;
    log.debug({ dbPath: this.dbPath, bytes: data.byteLength }, "store flushed");
  }

  /** Close + persist. */
  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }
}

type SqlParam = string | number | null;
export type { SqlParam };

let sqlPromise: Promise<SqlJsStatic> | null = null;
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      // sql.js needs to fetch its wasm file; point it at the package's dist.
      locateFile: (file: string) =>
        new URL(`../../node_modules/sql.js/dist/${file}`, import.meta.url).href,
    });
  }
  return sqlPromise;
}
