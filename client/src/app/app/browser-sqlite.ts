import type { CorrectionSet, LocalVideoRef } from '../../../../shared/calibration-contract';

export interface BrowserVideoStore {
  saveVideo(file: File): Promise<LocalVideoRef>;
  loadVideo(id: string): Promise<Blob>;
  deleteVideo(id: string): Promise<void>;
}

interface SqliteExecOptions {
  sql: string;
  bind?: unknown[];
  rowMode?: 'object';
}

interface SqliteRow {
  [key: string]: unknown;
  data?: unknown;
  mime_type?: unknown;
  payload?: unknown;
}

interface SqliteDatabase {
  exec(options: SqliteExecOptions): Promise<SqliteRow[]> | SqliteRow[] | undefined;
  close?(): void;
}

type DatabaseOpener = () => Promise<SqliteDatabase>;

export class BrowserSqliteStore implements BrowserVideoStore {
  private db?: SqliteDatabase;
  private opening?: Promise<SqliteDatabase>;

  constructor(private readonly openDatabase: DatabaseOpener = openWorkerDatabase) {}

  async saveVideo(file: File): Promise<LocalVideoRef> {
    const ref: LocalVideoRef = {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || 'video/mp4',
      size: file.size,
      lastModified: file.lastModified,
    };
    await this.exec({
      sql: 'INSERT INTO video_inputs (id, name, mime_type, size, last_modified, data) VALUES (?, ?, ?, ?, ?, ?)',
      bind: [ref.id, ref.name, ref.mimeType, ref.size, ref.lastModified, new Uint8Array(await readBlob(file))],
    });
    return ref;
  }

  async loadVideo(id: string): Promise<Blob> {
    const rows = await this.exec({
      sql: 'SELECT mime_type, data FROM video_inputs WHERE id = ?',
      bind: [id],
      rowMode: 'object',
    });
    const row = rows[0];
    if (!row) throw new Error('local video not found');
    const bytes = row.data as Uint8Array;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: String(row.mime_type) });
  }

  async deleteVideo(id: string) {
    await this.exec({ sql: 'DELETE FROM video_inputs WHERE id = ?', bind: [id] });
  }

  async saveCorrectionSet(set: CorrectionSet) {
    await this.exec({
      sql: 'INSERT OR REPLACE INTO local_correction_sets (id, analysis_id, payload, synchronized) VALUES (?, ?, ?, ?)',
      bind: [set.id, set.analysisId, JSON.stringify(set), set.accepted ? 1 : 0],
    });
  }

  async listCorrectionSets(analysisId: string): Promise<CorrectionSet[]> {
    const rows = await this.exec({
      sql: 'SELECT payload FROM local_correction_sets WHERE analysis_id = ? ORDER BY id DESC',
      bind: [analysisId],
      rowMode: 'object',
    });
    return rows.map((row) => JSON.parse(String(row.payload)) as CorrectionSet);
  }

  private async exec(options: SqliteExecOptions): Promise<SqliteRow[]> {
    try {
      const rows = await this.database().then((db) => db.exec(options));
      return rows ?? [];
    } catch (error) {
      throw storageError(error);
    }
  }

  private database() {
    if (this.db) return Promise.resolve(this.db);
    this.opening ??= this.openDatabase()
      .then((db) => {
        this.db = db;
        return db;
      })
      .catch((error) => {
        this.opening = undefined;
        throw storageError(error);
      });
    return this.opening;
  }
}

async function openWorkerDatabase(): Promise<SqliteDatabase> {
  if (typeof window === 'undefined') throw new Error('browser SQLite is only available in a browser');
  if (!window.crossOriginIsolated) throw new Error('browser storage requires cross-origin isolation');
  if (!navigator.storage?.getDirectory) throw new Error('browser storage requires OPFS support');

  const worker = new Worker(new URL('./browser-sqlite.worker', import.meta.url), { type: 'module' });
  const database = new WorkerSqliteDatabase(worker);
  await database.initialize();
  return database;
}

class WorkerSqliteDatabase implements SqliteDatabase {
  private nextRequestId = 0;
  private readonly pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (error: Error) => void }>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.rows ?? []);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'SQLite worker failed');
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
  }

  initialize() {
    return this.request({ type: 'init' });
  }

  exec(options: SqliteExecOptions) {
    return this.request({ type: 'exec', ...options });
  }

  close() {
    this.worker.terminate();
  }

  private request(message: WorkerRequest) {
    const id = ++this.nextRequestId;
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message });
    });
  }
}

interface WorkerRequest {
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

function storageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/cross-origin|isolat/i.test(message)) return new Error('Browser storage requires cross-origin isolation.');
  if (/opfs|missing required|filesystem/i.test(message)) return new Error('Browser storage is unavailable in this browser.');
  if (/wasm|webassembly|load|fetch/i.test(message)) return new Error('Browser SQLite could not load its database engine.');
  if (/quota|full|toobig|storage/i.test(message)) return new Error('Browser storage quota was exceeded.');
  return new Error(`Unable to use browser storage: ${message}`);
}

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('unable to read local video'));
    reader.readAsArrayBuffer(blob);
  });
}
