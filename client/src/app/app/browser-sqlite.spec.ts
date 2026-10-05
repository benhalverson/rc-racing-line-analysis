import { describe, expect, it } from 'vitest';
import { BrowserSqliteStore } from './browser-sqlite';

function fakeDatabase() {
  const videos = new Map<string, { mime_type: string; data: Uint8Array }>();
  const correctionSets = new Map<string, string>();
  return {
    exec({ sql, bind = [] }: { sql: string; bind?: unknown[] }) {
      if (sql.startsWith('INSERT INTO video_inputs')) {
        videos.set(String(bind[0]), { mime_type: String(bind[2]), data: bind[5] as Uint8Array });
      } else if (sql.startsWith('SELECT mime_type')) {
        return [...videos.entries()].map(([id, value]) => ({ id, ...value }));
      } else if (sql.startsWith('DELETE FROM video_inputs')) {
        videos.delete(String(bind[0]));
      } else if (sql.startsWith('INSERT OR REPLACE')) {
        correctionSets.set(String(bind[0]), String(bind[2]));
      } else if (sql.startsWith('SELECT payload')) {
        return [...correctionSets.values()].map((payload) => ({ payload }));
      }
      return [];
    },
  };
}

const correctionSet = {
  id: 'set-1',
  analysisId: 'analysis-1',
  version: 1,
  accepted: true,
  createdAt: '2026-07-14T00:00:00.000Z',
  raceStartSeconds: 1,
  markerReferenceSeconds: 2,
  carSelectionSeconds: 3,
  markers: [{ id: 'marker-1', position: { x: 0.2, y: 0.3 }, source: 'manual' as const }],
  selectedCarBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
};

describe('BrowserSqliteStore', () => {
  it('saves, loads, and deletes videos', async () => {
    const store = new BrowserSqliteStore(async () => fakeDatabase());
    const ref = await store.saveVideo(new File(['video bytes'], 'race.mp4', { type: 'video/mp4', lastModified: 42 }));

    expect(await store.loadVideo(ref.id)).toEqual(new Blob(['video bytes'], { type: 'video/mp4' }));
    await store.deleteVideo(ref.id);
    await expect(store.loadVideo(ref.id)).rejects.toThrow('local video not found');
  });

  it('persists and lists correction sets', async () => {
    const store = new BrowserSqliteStore(async () => fakeDatabase());
    await store.saveCorrectionSet(correctionSet);
    expect(await store.listCorrectionSets('analysis-1')).toEqual([correctionSet]);
  });

  it('shares concurrent initialization', async () => {
    const database = fakeDatabase();
    let openCount = 0;
    const store = new BrowserSqliteStore(async () => {
      openCount += 1;
      await Promise.resolve();
      return database;
    });
    await Promise.all([
      store.saveVideo(new File(['one'], 'one.mp4')),
      store.saveVideo(new File(['two'], 'two.mp4')),
    ]);
    expect(openCount).toBe(1);
  });

  it('retries after initialization fails', async () => {
    const database = fakeDatabase();
    let attempt = 0;
    const store = new BrowserSqliteStore(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('wasm load failed');
      return database;
    });
    await expect(store.saveVideo(new File(['one'], 'one.mp4'))).rejects.toThrow('database engine');
    await expect(store.saveVideo(new File(['two'], 'two.mp4'))).resolves.toBeDefined();
    expect(attempt).toBe(2);
  });
});
