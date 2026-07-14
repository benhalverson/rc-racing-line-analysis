import type { TimingImport, TimingLap } from "./timing-contract";

export type EvidenceQuality = "measured" | "uncertain" | "invalid";

export interface ReviewLap {
  crossingLapNumber: number;
  crossingSeconds: number;
  evidenceQuality: EvidenceQuality;
  liveRcLap: TimingLap;
  videoStartSeconds: number;
  videoEndSeconds: number;
}

export interface StartFinishPoint {
  x: number;
  y: number;
}

export interface RacingLineReview {
  laps: ReviewLap[];
  startFinish?: StartFinishPoint;
}

export function createRacingLineReview(timing: TimingImport): RacingLineReview {
  let crossingSeconds = 0;
  return {
    laps: timing.laps.map((liveRcLap) => {
      const videoStartSeconds = crossingSeconds;
      crossingSeconds += liveRcLap.lapTimeSeconds ?? 0;
      return {
        crossingLapNumber: liveRcLap.lapNumber,
        crossingSeconds,
        evidenceQuality: liveRcLap.valid === false ? "invalid" : liveRcLap.valid === true ? "measured" : "uncertain",
        liveRcLap,
        videoStartSeconds,
        videoEndSeconds: crossingSeconds,
      };
    }),
  };
}

export function correctLapCrossing(review: RacingLineReview, lapNumber: number, crossingSeconds: number): RacingLineReview {
  const index = review.laps.findIndex((lap) => lap.crossingLapNumber === lapNumber);
  if (index < 0 || !Number.isFinite(crossingSeconds) || crossingSeconds < 0) return review;
  const previousCrossing = index === 0 ? 0 : review.laps[index - 1].crossingSeconds;
  const nextCrossing = review.laps[index + 1]?.crossingSeconds;
  if (crossingSeconds < previousCrossing || (nextCrossing !== undefined && crossingSeconds > nextCrossing)) return review;
  return {
    ...review,
    laps: review.laps.map((lap, lapIndex) => {
      if (lapIndex === index) return { ...lap, crossingSeconds, videoEndSeconds: crossingSeconds };
      if (lapIndex === index + 1) return { ...lap, videoStartSeconds: crossingSeconds };
      return lap;
    }),
  };
}

export function assignLiveRcLap(review: RacingLineReview, crossingLapNumber: number, liveRcLapNumber: number): RacingLineReview {
  const replacement = review.laps.find((lap) => lap.liveRcLap.lapNumber === liveRcLapNumber)?.liveRcLap;
  if (!replacement) return review;
  return {
    ...review,
    laps: review.laps.map((lap) => lap.crossingLapNumber === crossingLapNumber ? { ...lap, liveRcLap: replacement } : lap),
  };
}
