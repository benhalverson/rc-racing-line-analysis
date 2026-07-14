import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { timingImports, timingLaps } from "./db/schema";
import type { TimingImport, TimingStore } from "./timing";

export class D1TimingStore implements TimingStore {
  private readonly db;
  constructor(database: D1Database) { this.db = drizzle(database); }
  async saveTimingImport(value: TimingImport) {
    await this.db.insert(timingImports).values({ id: value.id, source: value.source, trackHost: value.trackHost, trackName: value.trackName, trackUrl: value.trackUrl, eventName: value.eventName, eventUrl: value.eventUrl, raceId: value.raceId, raceLabel: value.raceLabel, roundLabel: value.roundLabel, classLabel: value.classLabel, raceUrl: value.raceUrl, driverName: value.driverName, normalizedDriverName: value.normalizedDriverName, driverId: value.driverId, fetchedAt: value.fetchedAt, parserVersion: value.parserVersion, sourceHash: value.sourceHash }).run();
    for (const lap of value.laps) await this.db.insert(timingLaps).values({ importId: value.id, lapNumber: lap.lapNumber, lapTimeSeconds: lap.lapTimeSeconds, lapTimeText: lap.lapTimeText, valid: lap.valid === null ? null : lap.valid ? 1 : 0, statusText: lap.statusText }).run();
  }
  async getTimingImport(id: string) {
    const row = await this.db.select().from(timingImports).where(eq(timingImports.id, id)).get();
    if (!row) return undefined;
    const laps = await this.db.select().from(timingLaps).where(eq(timingLaps.importId, id)).all();
    return { ...row, source: "liverc" as const, laps: laps.map((lap) => ({ lapNumber: lap.lapNumber, lapTimeSeconds: lap.lapTimeSeconds, lapTimeText: lap.lapTimeText, valid: lap.valid === null ? null : lap.valid === 1, statusText: lap.statusText })) };
  }
}
