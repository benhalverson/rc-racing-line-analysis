import { describe, expect, it } from "vitest";
import type { TimingImport, TimingImportRequest } from "../../shared/timing-contract";

describe("shared timing contract", () => {
  it("supports complete request and persisted import shapes", () => {
    const request: TimingImportRequest = {
      trackHost: "track.liverc.com", trackName: "Track", trackUrl: "https://track.liverc.com/", eventName: "Event",
      eventUrl: "https://track.liverc.com/event", raceId: null, raceLabel: "Race", roundLabel: "Round", classLabel: "Class",
      raceUrl: "https://track.liverc.com/race", driverName: "Driver", driverId: null,
    };
    const persisted: TimingImport = {
      ...request, id: "import-1", source: "liverc", raceId: request.raceId ?? null, driverId: request.driverId ?? null,
      normalizedDriverName: "driver", fetchedAt: "2026-07-14T00:00:00.000Z", parserVersion: "liverc-html-v1", sourceHash: "hash", laps: [],
    };
    expect(persisted).toMatchObject({ source: "liverc", raceId: null, driverId: null, laps: [] });
  });
});
