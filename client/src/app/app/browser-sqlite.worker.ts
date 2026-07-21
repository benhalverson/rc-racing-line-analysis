import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { resolveSqliteAssetUrl } from './sqlite-asset-url';

type SqliteDatabase = {
  exec(options: unknown): unknown;
};

type SqliteModule = {
  installOpfsSAHPoolVfs(options: { directory: string }): Promise<{ OpfsSAHPoolDb: new (filename: string) => SqliteDatabase }>;
  oo1?: object;
};

let database: SqliteDatabase | undefined;

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === 'init') {
      await initialize();
      respond({ id: data.id, rows: [] });
      return;
    }
    await initialize();
    if (!data.sql) throw new Error('SQLite request is missing SQL');
    const rows = database?.exec({ sql: data.sql, bind: data.bind, rowMode: data.rowMode, returnValue: 'resultRows' });
    respond({ id: data.id, rows: Array.isArray(rows) ? rows as Record<string, unknown>[] : [] });
  } catch (error) {
    respond({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

async function initialize() {
  if (database) return;
  (globalThis as typeof globalThis & { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
    disable: { vfs: { opfs: true, 'opfs-wl': true } },
  };
  const init = sqlite3InitModule as unknown as (options: { locateFile: (file: string) => string }) => Promise<SqliteModule>;
  const sqlite3 = await init({
    locateFile: (file: string) => resolveSqliteAssetUrl(file, self.location.origin),
  });
  if (!sqlite3.installOpfsSAHPoolVfs || !sqlite3.oo1) throw new Error('OPFS SQLite is unavailable');
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: '/rc-racing-line-analysis' });
  const db = new pool.OpfsSAHPoolDb('rc-racing-line-analysis.sqlite') as SqliteDatabase;
  database = db;
  db.exec({ sql: `CREATE TABLE IF NOT EXISTS video_inputs (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, last_modified INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS local_analyses (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_correction_sets (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, payload TEXT NOT NULL, synchronized INTEGER NOT NULL DEFAULT 0);` });
}

function respond(response: WorkerResponse) {
  self.postMessage(response);
}

interface WorkerRequest {
  id: number;
  type: 'init' | 'exec';
  sql?: string;
  bind?: unknown[];
  rowMode?: 'object';
}

interface WorkerResponse {
  id: number;
  rows?: Record<string, unknown>[];
  error?: string;
}
