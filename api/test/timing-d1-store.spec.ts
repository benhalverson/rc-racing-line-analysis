import { describe, expect, it } from "vitest";
import { timingImportFromRow, timingImportToRow, timingLapFromRow, timingLapToRow } from "../src/timing-d1-store";
import type { TimingImport } from "../../shared/timing-contract";

const value: TimingImport = {
  id: "import-1", source: "liverc", trackHost: "track.liverc.com", trackName: "Track", trackUrl: "https://track.liverc.com/",
  eventName: "Event", eventUrl: "https://track.liverc.com/event", raceId: null, raceLabel: "Race", roundLabel: "Round", classLabel: "Class",
  raceUrl: "https://track.liverc.com/race", driverName: "Driver", normalizedDriverName: "driver", driverId: "driver-1", fetchedAt: "2026-07-14T00:00:00.000Z",
  parserVersion: "liverc-html-v1", sourceHash: "hash", laps: [{ lapNumber: 1, lapTimeSeconds: null, lapTimeText: "DNF", valid: false, statusText: "DNF" }],
};

describe("timing D1 mapping", () => {
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
