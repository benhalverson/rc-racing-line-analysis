import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { timingImports, timingLaps } from "./db/schema";
import { toTimingImportSummary, type TimingImport, type TimingLap, type TimingStore } from "./timing";

type TimingImportRow = typeof timingImports.$inferSelect;
type TimingImportInsert = typeof timingImports.$inferInsert;
type TimingLapRow = typeof timingLaps.$inferSelect;
type TimingLapInsert = typeof timingLaps.$inferInsert;

export function timingImportToRow(value: TimingImport): TimingImportInsert {
  return {
    id: value.id,
    source: value.source,
    trackHost: value.trackHost,
    trackName: value.trackName,
    trackUrl: value.trackUrl,
    eventName: value.eventName,
    eventUrl: value.eventUrl,
    raceId: value.raceId,
    raceLabel: value.raceLabel,
    roundLabel: value.roundLabel,
    classLabel: value.classLabel,
    raceUrl: value.raceUrl,
    driverName: value.driverName,
    normalizedDriverName: value.normalizedDriverName,
    driverId: value.driverId,
    fetchedAt: value.fetchedAt,
    parserVersion: value.parserVersion,
    sourceHash: value.sourceHash,
  };
}

export function timingLapToRow(importId: string, lap: TimingLap): TimingLapInsert {
  return {
    importId,
    lapNumber: lap.lapNumber,
    lapTimeSeconds: lap.lapTimeSeconds,
    lapTimeText: lap.lapTimeText,
    valid: lap.valid === null ? null : lap.valid ? 1 : 0,
    statusText: lap.statusText,
  };
}

export function timingLapFromRow(row: TimingLapRow): TimingLap {
  return {
    lapNumber: row.lapNumber,
    lapTimeSeconds: row.lapTimeSeconds,
    lapTimeText: row.lapTimeText,
    valid: row.valid === null ? null : row.valid === 1,
    statusText: row.statusText,
  };
}

export function timingImportFromRow(row: TimingImportRow, laps: TimingLap[]): TimingImport {
  return { ...row, source: "liverc", laps };
}

export class D1TimingStore implements TimingStore {
  private readonly db;
  constructor(database: D1Database) { this.db = drizzle(database); }
  async saveTimingImport(value: TimingImport) {
    const lapRows = value.laps.map((lap) => timingLapToRow(value.id, lap));
    await this.db.batch([
      this.db.insert(timingImports).values(timingImportToRow(value)),
      ...(lapRows.length > 0 ? [this.db.insert(timingLaps).values(lapRows)] : []),
    ]);
  }
  async getTimingImport(id: string) {
    const row = await this.db.select().from(timingImports).where(eq(timingImports.id, id)).get();
    if (!row) return undefined;
    const laps = await this.db.select().from(timingLaps).where(eq(timingLaps.importId, id)).all();
    return timingImportFromRow(row, laps.map(timingLapFromRow));
  }
  async listTimingImports(limit: number) {
    const rows = await this.db.select().from(timingImports).orderBy(desc(timingImports.fetchedAt)).limit(limit).all();
    return rows.map((row) => toTimingImportSummary(timingImportFromRow(row, [])));
  }
}
