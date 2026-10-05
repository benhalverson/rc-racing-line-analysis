import type { TimingImport, TimingLap } from './timing-contract';
import type { CarObservation, TrackingArtifacts } from './tracking-contract';
import type { Point, StabilizationArtifacts } from './stabilization-contract';

export type EvidenceQuality = 'measured' | 'uncertain' | 'invalid';
export type StartFinishLine = { a: Point; b: Point };
export type ReviewCrossing = { id: string; seconds: number; source: 'detected' | 'manual'; frameBefore: number | null; frameAfter: number | null; liveRcLapNumber: number | null };
export type ReviewRevision = { version: number; evidenceId: string; runId: string; correctionSetId: string; timingImportId: string | null; startFinish: StartFinishLine | null; crossings: ReviewCrossing[] };
export type ReviewLap = { crossing: ReviewCrossing; liveRcLap: TimingLap | null; videoStartSeconds: number; videoEndSeconds: number; evidenceQuality: EvidenceQuality; warnings: string[] };
export type RacingLineReview = { revision: ReviewRevision; laps: ReviewLap[]; tracking: TrackingArtifacts; stabilization: StabilizationArtifacts; raceStartSeconds: number; timing: TimingImport | null };

/** Requires adjacent decoded, accepted observations from the same confirmed identity segment. */
export function connected(a: CarObservation, b: CarObservation): boolean {
  return !!a.trackPoint && !!b.trackPoint && a.frame + 1 === b.frame && a.seconds < b.seconds && a.segmentId !== null && a.segmentId === b.segmentId && ['tracked', 'reacquired'].includes(a.quality) && ['tracked', 'reacquired'].includes(b.quality);
}

/** Intersects actual observed motion with a finite reference-pixel gate; no gaps are interpolated. */
export function detectCrossings(tracking: TrackingArtifacts, line: StartFinishLine, raceStart: number): ReviewCrossing[] {
  const result: ReviewCrossing[] = [];
  const dx = line.b.x - line.a.x; const dy = line.b.y - line.a.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1) return result;
  for (let i = 1; i < tracking.observations.length; i++) {
    const a = tracking.observations[i - 1]; const b = tracking.observations[i];
    if (!connected(a, b) || !a.trackPoint || !b.trackPoint) continue;
    let before = dx * (a.trackPoint.y - line.a.y) - dy * (a.trackPoint.x - line.a.x);
    const after = dx * (b.trackPoint.y - line.a.y) - dy * (b.trackPoint.x - line.a.x);
    // Require a true side change, including exact gate samples but excluding tangential touches.
    if (after === 0) continue;
    if (before === 0) {
      let prior = i - 2;
      while (prior >= 0 && connected(tracking.observations[prior], tracking.observations[prior + 1])) {
        const point = tracking.observations[prior].trackPoint;
        if (!point) break;
        const side = dx * (point.y - line.a.y) - dy * (point.x - line.a.x);
        if (side !== 0) { before = side; break; }
        prior--;
      }
      if (before === 0 || Math.sign(before) === Math.sign(after)) continue;
      before = 0;
    } else if (Math.sign(before) === Math.sign(after)) continue;
    const fraction = before / (before - after);
    const x = a.trackPoint.x + fraction * (b.trackPoint.x - a.trackPoint.x);
    const y = a.trackPoint.y + fraction * (b.trackPoint.y - a.trackPoint.y);
    const gateFraction = ((x - line.a.x) * dx + (y - line.a.y) * dy) / (length * length);
    const seconds = a.seconds + fraction * (b.seconds - a.seconds);
    if (gateFraction < 0 || gateFraction > 1 || seconds <= raceStart || result.at(-1)?.seconds === seconds) continue;
    result.push({ id: `detected-${a.frame}-${b.frame}`, seconds, source: 'detected', frameBefore: a.frame, frameAfter: b.frame, liveRcLapNumber: null });
  }
  return result;
}

/** Builds lap intervals only from explicit crossings and the accepted video race-start point. */
export function createRacingLineReview(revision: ReviewRevision, tracking: TrackingArtifacts, stabilization: StabilizationArtifacts, raceStartSeconds: number, timing: TimingImport | null): RacingLineReview {
  const laps = revision.crossings.map((crossing, index): ReviewLap => {
    const start = revision.crossings[index - 1]?.seconds ?? raceStartSeconds;
    const observations = tracking.observations.filter(o => o.seconds >= start && o.seconds <= crossing.seconds);
    const liveRcLap = timing?.laps.find(lap => lap.lapNumber === crossing.liveRcLapNumber) ?? null;
    const warnings: string[] = [];
    const transforms = stabilization.transforms.filter(t => t.seconds !== undefined && t.seconds >= start && t.seconds <= crossing.seconds);
    const covering = tracking.observations.filter(o => o.seconds <= start).at(-1);
    const ending = tracking.observations.find(o => o.seconds >= crossing.seconds);
    if (covering && !observations.includes(covering)) observations.unshift(covering);
    if (ending && !observations.includes(ending)) observations.push(ending);
    if (!covering || !ending || !observations.length) warnings.push('Video segment is outside decoded tracking evidence.');
    if (observations.some(o => o.quality === 'lost')) warnings.push('Selected-car identity was lost; no path is filled.');
    if (observations.some(o => o.quality === 'suspect')) warnings.push('Tracking is uncertain.');
    if (observations.some(o => !o.trackPoint) || transforms.some(t => !t.quality.usable)) warnings.push('Track-relative geometry is unavailable or rejected.');
    if (!liveRcLap) warnings.push('No LiveRC lap assigned.');
    else if (liveRcLap.valid !== true || liveRcLap.lapTimeSeconds === null) warnings.push('LiveRC lap validity or duration is uncertain.');
    if (liveRcLap?.lapTimeSeconds !== null && liveRcLap?.lapTimeSeconds !== undefined && Math.abs(liveRcLap.lapTimeSeconds - (crossing.seconds - start)) > Math.max(.1, liveRcLap.lapTimeSeconds * .05)) warnings.push('Video interval differs from LiveRC duration; verify lap assignment.');
    if (crossing.source === 'manual') warnings.push('Crossing timestamp was manually corrected.');
    const invalid = liveRcLap?.valid === false || !covering || !ending || observations.some(o => o.quality === 'lost' || !o.trackPoint) || transforms.some(t => !t.quality.usable);
    return { crossing, liveRcLap, videoStartSeconds: start, videoEndSeconds: crossing.seconds, evidenceQuality: invalid ? 'invalid' : warnings.length ? 'uncertain' : 'measured', warnings };
  });
  return { revision, laps, tracking, stabilization, raceStartSeconds, timing };
}
