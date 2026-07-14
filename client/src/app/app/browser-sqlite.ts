import type { CorrectionSet, LocalVideoRef } from '../../../../shared/calibration-contract';

export interface BrowserVideoStore {
  saveVideo(file: File): Promise<LocalVideoRef>;
  loadVideo(id: string): Promise<Blob>;
  deleteVideo(id: string): Promise<void>;
}

interface SqliteDatabase {
  exec(options: { sql: string; bind?: unknown[]; rowMode?: 'object'; resultRows?: Record<string, unknown>[] }): void;
  close(): void;
}

export class BrowserSqliteStore implements BrowserVideoStore {
  private db?: SqliteDatabase;
  private opening?: Promise<SqliteDatabase>;
  constructor(private readonly openDatabase: () => Promise<SqliteDatabase> = openOpfsDatabase) {}

  async saveVideo(file: File): Promise<LocalVideoRef> {
    const ref: LocalVideoRef = { id: crypto.randomUUID(), name: file.name, mimeType: file.type || 'video/mp4', size: file.size, lastModified: file.lastModified };
    const db = await this.database();
    try { db.exec({ sql: 'INSERT INTO video_inputs (id, name, mime_type, size, last_modified, data) VALUES (?, ?, ?, ?, ?, ?)', bind: [ref.id, ref.name, ref.mimeType, ref.size, ref.lastModified, new Uint8Array(await file.arrayBuffer())] }); }
    catch (error) { throw storageError(error); }
    return ref;
  }
  async loadVideo(id: string): Promise<Blob> {
    const rows: Record<string, unknown>[] = [];
    (await this.database()).exec({ sql: 'SELECT mime_type, data FROM video_inputs WHERE id = ?', bind: [id], rowMode: 'object', resultRows: rows });
    const row = rows[0];
    if (!row) throw new Error('local video not found');
    return new Blob([row['data'] as ArrayBufferView<ArrayBuffer>], { type: String(row['mime_type']) });
  }
  async deleteVideo(id: string) { (await this.database()).exec({ sql: 'DELETE FROM video_inputs WHERE id = ?', bind: [id] }); }
  async saveCorrectionSet(set: CorrectionSet) { (await this.database()).exec({ sql: 'INSERT OR REPLACE INTO local_correction_sets (id, analysis_id, payload, synchronized) VALUES (?, ?, ?, ?)', bind: [set.id, set.analysisId, JSON.stringify(set), set.accepted ? 1 : 0] }); }
  async listCorrectionSets(analysisId: string): Promise<CorrectionSet[]> {
    const rows: Record<string, unknown>[] = [];
    (await this.database()).exec({ sql: 'SELECT payload FROM local_correction_sets WHERE analysis_id = ? ORDER BY id DESC', bind: [analysisId], rowMode: 'object', resultRows: rows });
    return rows.map((row) => JSON.parse(String(row['payload'])) as CorrectionSet);
  }
  private database() { if (this.db) return Promise.resolve(this.db); this.opening ??= this.openDatabase().then((db) => { this.db = db; return db; }); return this.opening; }
}

async function openOpfsDatabase(): Promise<SqliteDatabase> {
  if (typeof window === 'undefined') throw new Error('browser SQLite is only available in a browser');
  const module = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await (module.default as unknown as () => Promise<any>)();
  const db = new sqlite3.oo1.DB('file:rc-racing-line-analysis.sqlite?vfs=opfs-sahpool', 'c');
  db.exec({ sql: `CREATE TABLE IF NOT EXISTS video_inputs (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, last_modified INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS local_analyses (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_correction_sets (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, payload TEXT NOT NULL, synchronized INTEGER NOT NULL DEFAULT 0);` });
  return db as unknown as SqliteDatabase;
}

function storageError(error: unknown) { return new Error(`Unable to save video in browser storage: ${error instanceof Error ? error.message : 'storage quota exceeded or unavailable'}`); }
