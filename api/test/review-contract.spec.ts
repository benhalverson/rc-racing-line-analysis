import { describe, expect, it } from "vitest";
import { assignLiveRcLap, correctLapCrossing, createRacingLineReview } from "../../shared/review-contract";
import type { TimingImport } from "../../shared/timing-contract";

const timing: TimingImport = {
  id: "import-1", source: "liverc", trackHost: "track.liverc.com", trackName: "Track", trackUrl: "https://track.liverc.com/",
  eventName: "Event", eventUrl: "https://track.liverc.com/event", raceId: "1", raceLabel: "Main", roundLabel: "Round",
  classLabel: "Buggy", raceUrl: "https://track.liverc.com/race", driverName: "Driver", normalizedDriverName: "driver",
  driverId: null, fetchedAt: "2026-07-14T00:00:00.000Z", parserVersion: "liverc-html-v1", sourceHash: "hash",
  laps: [
    { lapNumber: 1, lapTimeSeconds: 20, lapTimeText: "20.000", valid: true, statusText: null },
    { lapNumber: 2, lapTimeSeconds: 25, lapTimeText: "25.000", valid: null, statusText: null },
    { lapNumber: 3, lapTimeSeconds: 30, lapTimeText: "30.000", valid: false, statusText: "Invalid" },
  ],
};

describe("racing line review contract", () => {
  it("creates contiguous video segments and distinguishes timing evidence quality", () => {
    const review = createRacingLineReview(timing);
    expect(review.laps).toMatchObject([
      { videoStartSeconds: 0, videoEndSeconds: 20, evidenceQuality: "measured" },
      { videoStartSeconds: 20, videoEndSeconds: 45, evidenceQuality: "uncertain" },
      { videoStartSeconds: 45, videoEndSeconds: 75, evidenceQuality: "invalid" },
    ]);
  });

  it("allows a crossing correction and an explicit LiveRC lap assignment", () => {
    const corrected = correctLapCrossing(createRacingLineReview(timing), 2, 47);
    expect(corrected.laps[1]).toMatchObject({ videoStartSeconds: 20, videoEndSeconds: 47, crossingSeconds: 47 });
    expect(corrected.laps[2].videoStartSeconds).toBe(47);
    expect(assignLiveRcLap(corrected, 2, 3).laps[1].liveRcLap.lapNumber).toBe(3);
  });
});
