import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1TimingStore, timingImportFromRow, timingImportToRow, timingLapFromRow, timingLapToRow } from "../src/timing-d1-store";
import type { TimingImport } from "../../shared/timing-contract";

const value: TimingImport = {
  id: "import-1", source: "liverc", trackHost: "track.liverc.com", trackName: "Track", trackUrl: "https://track.liverc.com/",
  eventName: "Event", eventUrl: "https://track.liverc.com/event", raceId: null, raceLabel: "Race", roundLabel: "Round", classLabel: "Class",
  raceUrl: "https://track.liverc.com/race", driverName: "Driver", normalizedDriverName: "driver", driverId: "driver-1", fetchedAt: "2026-07-14T00:00:00.000Z",
  parserVersion: "liverc-html-v1", sourceHash: "hash", laps: [
    { lapNumber: 1, lapTimeSeconds: null, lapTimeText: "DNF", valid: false, statusText: "DNF" },
    { lapNumber: 2, lapTimeSeconds: 42.5, lapTimeText: "42.500", valid: true, statusText: null },
  ],
};

const d1 = vi.hoisted(() => ({
  batch: vi.fn(),
  insert: vi.fn(() => ({ values: vi.fn((row: unknown) => ({ row })) })),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: vi.fn(() => d1) }));

describe("timing D1 mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits the import header and all laps through one atomic batch", async () => {
    d1.batch.mockResolvedValue([]);
    await new D1TimingStore({} as D1Database).saveTimingImport(value);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toEqual([
      { row: timingImportToRow(value) },
      { row: value.laps.map((lap) => timingLapToRow(value.id, lap)) },
    ]);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(2);
    expect(d1.insert).toHaveBeenCalledTimes(2);
  });

  it("submits only the import header when there are no laps", async () => {
    d1.batch.mockResolvedValue([]);
    const emptyImport = { ...value, laps: [] };

    await new D1TimingStore({} as D1Database).saveTimingImport(emptyImport);

    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toEqual([{ row: timingImportToRow(emptyImport) }]);
    expect(d1.insert).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed batch so callers cannot observe a partial import", async () => {
    const failure = new Error("lap insert failed");
    d1.batch.mockRejectedValueOnce(failure);
    await expect(new D1TimingStore({} as D1Database).saveTimingImport(value)).rejects.toBe(failure);
  });

  it("maps every import field and nullable ID to the existing row shape", () => {
    expect(timingImportToRow(value)).toEqual({ ...value, laps: undefined });
  });

  it("maps every lap field and converts SQLite booleans", () => {
    const row = timingLapToRow(value.id, value.laps[0]);
    expect(row).toMatchObject({ importId: "import-1", lapNumber: 1, lapTimeSeconds: null, lapTimeText: "DNF", valid: 0, statusText: "DNF" });
    const fromRow = (id: number, valid: number | null) => timingLapFromRow({ id, importId: value.id, lapNumber: value.laps[0].lapNumber, lapTimeSeconds: value.laps[0].lapTimeSeconds, lapTimeText: value.laps[0].lapTimeText, valid, statusText: value.laps[0].statusText });
    expect(fromRow(1, 0)).toEqual(value.laps[0]);
    expect(fromRow(2, null).valid).toBeNull();
    expect(fromRow(3, 1).valid).toBe(true);
  });

  it("maps a complete row back to the domain import", () => {
    const row = timingImportToRow(value);
    expect(timingImportFromRow({ ...row, raceId: row.raceId ?? null, driverId: row.driverId ?? null } as Parameters<typeof timingImportFromRow>[0], value.laps)).toEqual(value);
  });
});
