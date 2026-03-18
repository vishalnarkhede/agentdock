import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";

const CONFIG_DIR = join(process.env.HOME || "", ".config", "agentdock");
const DB_PATH = join(CONFIG_DIR, "shared.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(CONFIG_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      branch TEXT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      status TEXT DEFAULT 'open',
      feature TEXT,
      ticket_id TEXT,
      session_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      session_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return _db;
}

// ─── PR operations ───

export interface PR {
  id?: number;
  repo: string;
  branch?: string;
  url: string;
  title?: string;
  status?: string;
  feature?: string;
  ticket_id?: string;
  session_name?: string;
  created_at?: string;
  updated_at?: string;
}

export function upsertPr(pr: PR): PR {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO prs (repo, branch, url, title, status, feature, ticket_id, session_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title = COALESCE(excluded.title, title),
      status = COALESCE(excluded.status, status),
      feature = COALESCE(excluded.feature, feature),
      ticket_id = COALESCE(excluded.ticket_id, ticket_id),
      branch = COALESCE(excluded.branch, branch),
      updated_at = datetime('now')
  `);
  stmt.run(
    pr.repo,
    pr.branch || null,
    pr.url,
    pr.title || null,
    pr.status || "open",
    pr.feature || null,
    pr.ticket_id || null,
    pr.session_name || null,
  );
  return db.prepare("SELECT * FROM prs WHERE url = ?").get(pr.url) as PR;
}

export function updatePr(url: string, updates: Partial<PR>): PR | null {
  const db = getDb();
  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (key === "url" || key === "id" || key === "created_at") continue;
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return null;

  fields.push("updated_at = datetime('now')");
  values.push(url);

  db.prepare(`UPDATE prs SET ${fields.join(", ")} WHERE url = ?`).run(...values);
  return db.prepare("SELECT * FROM prs WHERE url = ?").get(url) as PR | null;
}

export function listPrs(filters?: { repo?: string; feature?: string; status?: string; session_name?: string }): PR[] {
  const db = getDb();
  const where: string[] = [];
  const values: any[] = [];

  if (filters?.repo) { where.push("repo = ?"); values.push(filters.repo); }
  if (filters?.feature) { where.push("feature = ?"); values.push(filters.feature); }
  if (filters?.status) { where.push("status = ?"); values.push(filters.status); }
  if (filters?.session_name) { where.push("session_name = ?"); values.push(filters.session_name); }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM prs ${clause} ORDER BY updated_at DESC`).all(...values) as PR[];
}

// ─── Notes operations ───

export interface Note {
  id?: number;
  key: string;
  content: string;
  session_name?: string;
  created_at?: string;
}

export function addNote(note: Note): Note {
  const db = getDb();
  const stmt = db.prepare("INSERT INTO notes (key, content, session_name) VALUES (?, ?, ?)");
  const result = stmt.run(note.key, note.content, note.session_name || null);
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(result.lastInsertRowid) as Note;
}

export function listNotes(key?: string): Note[] {
  const db = getDb();
  if (key) {
    return db.prepare("SELECT * FROM notes WHERE key = ? ORDER BY created_at DESC").all(key) as Note[];
  }
  return db.prepare("SELECT * FROM notes ORDER BY created_at DESC LIMIT 100").all() as Note[];
}
