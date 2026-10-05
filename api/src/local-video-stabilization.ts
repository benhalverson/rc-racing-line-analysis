import { spawn } from 'node:child_process';
import { NumericalMarkerTransformEstimator } from './numerical-stabilization';
import { MarkerBasedStabilizationProvider, type MarkerObservation, type MarkerStabilizationProvider, type Point, type StabilizationArtifacts, type TrackTransform } from './stabilization';

export const STABILIZATION_PROVIDER_VERSION = "local-marker-v1";

export type VideoFrame = { frame: number; seconds: number; width: number; height: number; totalFrames?: number; rgb: Uint8Array };
export interface VideoFrameSource { frames(path: string, signal?: AbortSignal): AsyncIterable<VideoFrame>; }
export type AcceptedMarker = { id: string; position: Point };
export type LocalVideoStabilizationOptions = { videoPath: string; markers: AcceptedMarker[]; markerReferenceSeconds: number; raceStartSeconds: number; startFrame?: number; signal?: AbortSignal; onFrame?: (artifacts: StabilizationArtifacts) => Promise<void> };

/** Collects metadata from a local executable and propagates exit failures. */
async function probe(path: string, signal?: AbortSignal): Promise<{ width: number; height: number; timestamps: number[] }> {
  const process = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'stream=width,height,r_frame_rate:frame=best_effort_timestamp_time', '-of', 'json', path], { signal });
  let stdout = ''; let stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk.toString(); }); process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  await new Promise<void>((resolve, reject) => { process.on('error', reject); process.on('close', code => code === 0 ? resolve() : reject(new Error(`Local video probe failed: ${stderr}`))); });
  const metadata = JSON.parse(stdout);
  const stream = metadata.streams?.[0]; const [numerator, denominator] = String(stream?.r_frame_rate).split('/').map(Number);
  const fps = numerator / denominator;
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height) || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 33_177_600 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid local video dimensions or frame rate');
  const timestamps: number[] = (metadata.frames ?? []).map((frame: { best_effort_timestamp_time?: string }) => Number(frame.best_effort_timestamp_time));
  if (!timestamps.length || timestamps.some((seconds, index) => !Number.isFinite(seconds) || seconds < 0 || (index > 0 && seconds <= timestamps[index - 1]))) throw new Error('Invalid or unordered local video timestamps');
  const start = timestamps[0];
  return { width: stream.width, height: stream.height, timestamps: timestamps.map(seconds => seconds - start) };
}

/** Decodes every local video frame with ffmpeg; no video leaves the machine. */
export class FfmpegVideoFrameSource implements VideoFrameSource {
  /** Streams RGB frames with bounded buffering and cancellation. */
  async *frames(path: string, signal?: AbortSignal): AsyncIterable<VideoFrame> {
    const { width, height, timestamps } = await probe(path, signal);
    const process = spawn('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { signal });
    let stderr = ''; process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const completion = new Promise<void>((resolve, reject) => { process.on('error', reject); process.on('close', code => code === 0 ? resolve() : reject(new Error(`Local video decoding failed: ${stderr}`))); });
    // Attach immediately so cancellation cannot create an unhandled rejection during iteration.
    completion.catch(() => undefined);
    let pending = Buffer.alloc(0); let frame = 0; const bytes = width * height * 3;
    try {
      for await (const chunk of process.stdout) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= bytes) {
          signal?.throwIfAborted();
          yield { frame, seconds: timestamps[frame], width, height, totalFrames: timestamps.length, rgb: pending.subarray(0, bytes) };
          frame++; pending = pending.subarray(bytes);
        }
      }
      await completion;
      if (pending.length || !frame || frame !== timestamps.length) throw new Error('Local video contained a truncated or missing frame');
    } finally { if (process.exitCode === null) process.kill(); }
  }
}

/** Finds green connected components without native or browser-only dependencies. */
export function detectFrameMarkers(frame: VideoFrame): Point[] {
  const { width, height, rgb } = frame; const seen = new Uint8Array(width * height); const points: Point[] = [];
  /** Tests a pixel against the green-marker color rule. */
  const green = (index: number): boolean => rgb[index * 3 + 1] > 70 && rgb[index * 3 + 1] > rgb[index * 3] * 1.35 && rgb[index * 3 + 1] > rgb[index * 3 + 2] * 1.2;
  for (let pixel = 0; pixel < seen.length; pixel++) {
    if (seen[pixel] || !green(pixel)) continue;
    const queue = [pixel]; seen[pixel] = 1; let sumX = 0; let sumY = 0;
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]; const x = current % width; const y = Math.floor(current / width); sumX += x; sumY += y;
      for (const adjacent of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) if (adjacent >= 0 && !seen[adjacent] && green(adjacent)) { seen[adjacent] = 1; queue.push(adjacent); }
    }
    if (queue.length >= 4 && queue.length <= width * height * 0.02) points.push({ x: sumX / queue.length, y: sumY / queue.length });
  }
  return points;
}

/** Matches accepted marker identities one-to-one; ambiguous assignments are omitted. */
function observationsFor(frame: VideoFrame, markers: AcceptedMarker[], prior: Map<string, Point>, reference: Map<string, Point>): MarkerObservation[] {
  const candidates = detectFrameMarkers(frame); const result: MarkerObservation[] = []; const used = new Set<number>(); const radius = Math.min(frame.width, frame.height) * 0.15;
  for (const marker of markers) {
    const trackPoint = reference.get(marker.id);
    if (!trackPoint) throw new Error("Missing accepted marker reference");
    const anchor = prior.get(marker.id) ?? trackPoint;
    const ranked = candidates.map((point, index) => ({ point, index, distance: Math.hypot(point.x - anchor.x, point.y - anchor.y) })).sort((a, b) => a.distance - b.distance);
    const closest = ranked[0];
    if (!closest || used.has(closest.index) || closest.distance > radius || (ranked[1] && ranked[1].distance - closest.distance < radius * 0.15)) continue;
    // Reject a component that is also closer to another accepted marker's anchor.
    if (markers.some(other => { const otherAnchor = prior.get(other.id) ?? reference.get(other.id); return other.id !== marker.id && otherAnchor && Math.hypot(closest.point.x - otherAnchor.x, closest.point.y - otherAnchor.y) <= closest.distance; })) continue;
    used.add(closest.index); prior.set(marker.id, closest.point);
    result.push({ frame: frame.frame, markerId: marker.id, imagePoint: closest.point, trackPoint, confidence: Math.max(0.5, 1 - closest.distance / radius / 2) });
  }
  return result;
}

/** Executes observations and numerical estimation against accepted local calibration. */
export class LocalVideoStabilizationProvider implements MarkerStabilizationProvider {
  /** Accepts the local video and authoritative correction-set markers. */
  constructor(private readonly options: LocalVideoStabilizationOptions, private readonly source: VideoFrameSource = new FfmpegVideoFrameSource()) {}

  /** Processes every race frame, emitting checkpoints and explicit unusable frames. */
  async stabilize(): Promise<StabilizationArtifacts> {
    const options = this.options;
    if (!Number.isFinite(options.markerReferenceSeconds) || options.markerReferenceSeconds < 0 || !Number.isFinite(options.raceStartSeconds) || options.raceStartSeconds < 0 || new Set(options.markers.map(marker => marker.id)).size !== options.markers.length || options.markers.some(marker => !marker.id || !Number.isFinite(marker.position.x) || !Number.isFinite(marker.position.y) || marker.position.x < 0 || marker.position.x > 1 || marker.position.y < 0 || marker.position.y > 1)) throw new Error('Invalid accepted marker calibration');
    let referenceFrame: VideoFrame | undefined; let previous: VideoFrame | undefined;
    for await (const frame of this.source.frames(options.videoPath, options.signal)) {
      if (frame.seconds >= options.markerReferenceSeconds) { referenceFrame = previous && Math.abs(previous.seconds - options.markerReferenceSeconds) < Math.abs(frame.seconds - options.markerReferenceSeconds) ? previous : frame; break; }
      previous = { ...frame, rgb: frame.rgb.slice() };
    }
    if (!referenceFrame) throw new Error('Accepted marker reference frame is outside the local video');
    const reference = new Map(options.markers.map(marker => [marker.id, { x: marker.position.x * referenceFrame.width, y: marker.position.y * referenceFrame.height }]));
    const prior = new Map(reference); const markerObservations: MarkerObservation[] = []; const transforms: TrackTransform[] = []; let lastFrame = -1; let totalFrames: number | undefined;
    for await (const frame of this.source.frames(options.videoPath, options.signal)) {
      options.signal?.throwIfAborted();
      if (frame.frame !== lastFrame + 1 || frame.width !== referenceFrame.width || frame.height !== referenceFrame.height || frame.rgb.length !== frame.width * frame.height * 3 || !Number.isFinite(frame.seconds)) throw new Error('Missing, unordered, or invalid local video frame');
      lastFrame = frame.frame;
      const observations = observationsFor(frame, options.markers, prior, reference);
      if (frame.seconds >= options.raceStartSeconds && totalFrames === undefined && frame.totalFrames !== undefined) totalFrames = frame.totalFrames - frame.frame;
      if (frame.seconds < options.raceStartSeconds || frame.frame < (options.startFrame ?? 0)) continue;
      const artifacts = await new MarkerBasedStabilizationProvider(observations, new NumericalMarkerTransformEstimator(frame.width, frame.height), undefined, [frame.frame]).stabilize();
      artifacts.transforms.forEach(transform => { transform.seconds = frame.seconds; });
      markerObservations.push(...artifacts.markerObservations); transforms.push(...artifacts.transforms);
      if (transforms.length % 30 === 0) await options.onFrame?.({ coordinateSystem: "reference-pixels", referenceSize: { width: referenceFrame.width, height: referenceFrame.height }, totalFrames, markerObservations: [...markerObservations], transforms: [...transforms] });
    }
    if (!transforms.length) throw new Error('No race frames available for stabilization');
    await options.onFrame?.({ coordinateSystem: "reference-pixels", referenceSize: { width: referenceFrame.width, height: referenceFrame.height }, totalFrames, markerObservations: [...markerObservations], transforms: [...transforms] });
    return { coordinateSystem: "reference-pixels", referenceSize: { width: referenceFrame.width, height: referenceFrame.height }, totalFrames, markerObservations, transforms };
  }
}
