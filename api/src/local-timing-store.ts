import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { timingImports, timingLaps } from "./db/schema";
import { timingImportFromRow, timingImportToRow, timingLapFromRow, timingLapToRow } from "./timing-d1-store";
import { toTimingImportSummary, type TimingImport, type TimingStore } from "./timing";

/** Preserves existing LiveRC metadata behavior in the local SQLite runtime. */
export class LocalTimingStore implements TimingStore {
  /** Shares the local metadata database with analysis records. */
  constructor(private readonly db: BetterSQLite3Database) {}
  /** Atomically persists an imported result and its individual lap rows. */
  async saveTimingImport(value: TimingImport): Promise<void> {
    this.db.transaction((tx) => {
      tx.insert(timingImports).values(timingImportToRow(value)).run();
      if (value.laps.length) tx.insert(timingLaps).values(value.laps.map((lap) => timingLapToRow(value.id, lap))).run();
    });
  }
  /** Reads a reusable imported timing record and its laps. */
  async getTimingImport(id: string) {
    const row = this.db.select().from(timingImports).where(eq(timingImports.id, id)).get();
    if (!row) return undefined;
    const laps = this.db.select().from(timingLaps).where(eq(timingLaps.importId, id)).all();
    return timingImportFromRow(row, laps.map(timingLapFromRow));
  }
  /** Lists the most recent imported timing summaries. */
  async listTimingImports(limit: number) {
    return this.db.select().from(timingImports).orderBy(desc(timingImports.fetchedAt)).limit(limit).all().map((row) => toTimingImportSummary(timingImportFromRow(row, [])));
  }
}
