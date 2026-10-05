import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { executeLocalStabilization } from "../src/processing-local";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/local-artifacts";
import { LocalPersistence } from "../src/local-persistence";
import { createLocalApp } from "../src/local-runtime";
import { LocalVideoStore } from "../src/local-video-store";
import { AnalysisWorkflow } from "../src/workflow";

const roots: string[] = [];
const stores: LocalPersistence[] = [];
const migrations = fileURLToPath(new URL("../drizzle/local-migrations", import.meta.url));
const correction = { raceStartSeconds: 0, markerReferenceSeconds: 0, carSelectionSeconds: 0, markers: [{ id: "a", position: { x: 0.2, y: 0.2 }, source: "manual" as const }, { id: "b", position: { x: 0.8, y: 0.2 }, source: "manual" as const }, { id: "c", position: { x: 0.2, y: 0.8 }, source: "manual" as const }], selectedCarBox: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } };

/** Creates an isolated real SQLite database and local file store for public-port tests. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rc-local-")); roots.push(root);
  const persistence = new LocalPersistence(join(root, "metadata.sqlite"), migrations); stores.push(persistence);
  const artifacts = new LocalArtifactStore(join(root, "artifacts"), persistence);
  const videos = new LocalVideoStore(join(root, "videos"));
  const workflow = new AnalysisWorkflow(persistence);
  return { root, persistence, artifacts, videos, workflow };
}

afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("local production persistence", () => {
  it("rejects overlapping resume while cancellation drains and resumes after settlement", async () => {
    const { persistence, artifacts, videos, workflow } = await fixture();
    const video = await videos.importVideo(new File(["fixture"], "race.mp4"));
    const draft = await workflow.createDraft({ ...video, videoName: "race.mp4", videoStorage: "local-disk" });
    await workflow.startCalibration(draft.id);
    const accepted = await workflow.createAndAcceptCorrectionSet(draft.id, correction);
    await workflow.queue(draft.id);
    let release: () => void = () => undefined;
    const draining = new Promise<void>(resolve => { release = resolve; });
    let started: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const app = createLocalApp(workflow, persistence, artifacts, videos, async (id, signal) => {
      const run = await persistence.startRun(id, accepted.id, "race-fixture");
      calls++;
      if (calls === 1) {
        started();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        await draining;
        await persistence.updateRun(run.id, { status: "cancelled" });
        if ((await workflow.get(id)).state === "running") await workflow.cancel(id);
      } else {
        await persistence.updateRun(run.id, { status: "completed" });
        await workflow.complete(id);
      }
    });
    const post = (action: string) => app.request(`http://localhost/analyses/${draft.id}/${action}`, { method: "POST" });
    expect((await post("start")).status).toBe(200); await entered;
    const cancellation = post("cancel");
    // Let the HTTP adapter set abort while its provider deliberately delays settlement.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await post("resume")).status).toBe(400);
    release(); expect((await cancellation).status).toBe(200);
    expect((await post("resume")).status).toBe(200);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(2);
    expect((await workflow.get(draft.id)).state).toBe("completed");
  });

  it("retains accepted correction authority, checkpoints, local references, and new run history across reopen", async () => {
    const { root, persistence, artifacts, videos, workflow } = await fixture();
    const input = await videos.importVideo(new File([new Uint8Array([1, 2, 3])], "race.mp4", { type: "video/mp4" }));
    const draft = await workflow.createDraft({ ...input, videoName: "race.mp4", videoStorage: "local-disk" });
    await workflow.startCalibration(draft.id);
    const accepted = await workflow.createAndAcceptCorrectionSet(draft.id, correction);
    await workflow.queue(draft.id); await workflow.start(draft.id);
    const run = await persistence.startRun(draft.id, accepted.id, "fixture-v1");
    const outputs = { markerObservations: [], transforms: [] };
    await artifacts.writeCheckpoint(run, outputs);
    await persistence.updateRun(run.id, { frame: 12, status: "cancelled" });
    expect((await persistence.startRun(draft.id, accepted.id, "fixture-v1")).id).toBe(run.id);
    await artifacts.commit(run, outputs);
    await persistence.updateRun(run.id, { status: "completed" });
    const next = await persistence.startRun(draft.id, accepted.id, "fixture-v1", true);
    expect(next.id).not.toBe(run.id);
    expect((await persistence.listArtifacts(draft.id))[0].runId).toBe(run.id);
    const reopened = new LocalPersistence(join(root, "metadata.sqlite"), migrations); stores.push(reopened);
    expect((await reopened.get(draft.id))?.acceptedCorrectionSetId).toBe(accepted.id);
    expect((await reopened.listCorrectionSets(draft.id))[0]).toMatchObject({ accepted: true, version: 1 });
    expect(await artifacts.readCheckpoint(run)).toEqual(outputs);
    expect((await stat(videos.resolvePath(input.videoPath))).size).toBe(3);
    expect((await reopened.listArtifacts(draft.id)).every((item) => item.path.startsWith(root))).toBe(true);
    expect(JSON.parse(await readFile((await reopened.listArtifacts(draft.id))[0].path, "utf8"))).toEqual([]);
  });

  it("exposes real local video transfer without bypassing calibration and rejects traversal", async () => {
    const { persistence, artifacts, videos, workflow } = await fixture();
    const app = createLocalApp(workflow, persistence, artifacts, videos, async () => undefined);
    expect((await app.request("http://localhost/runtime")).status).toBe(200);
    const body = new File(["video"], "race.mp4", { type: "video/mp4" });
    const imported = await (await app.request("http://localhost/local-videos", { method: "POST", body, headers: { "x-video-name": encodeURIComponent(body.name), "content-type": body.type, "x-video-last-modified": String(body.lastModified) } })).json() as Awaited<ReturnType<LocalVideoStore["importVideo"]>>;
    expect(imported.videoPath).toMatch(/^local-disk:\/\//);
    const response = await app.request("http://localhost/analyses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...imported, videoStorage: "local-disk", videoName: "race.mp4" }) });
    expect(response.status).toBe(201);
    const draft = await response.json() as { id: string };
    expect((await app.request(`http://localhost/analyses/${draft.id}/queue`, { method: "POST" })).status).toBe(400);
    expect(() => videos.resolvePath("local-disk://../outside")).toThrow("invalid local video reference");
    expect((await app.request("http://localhost/runtime", { headers: { origin: "https://example.com" } })).status).toBe(403);
  });
  it.each([false, true])("runs production frame decoding through local import and persisted quality gating (marker loss=%s)", async (markerLoss) => {
    const { root, persistence, artifacts, videos, workflow } = await fixture();
    const frames = [0, 3].map((shift, index) => {
      const rgb = Buffer.alloc(100 * 100 * 3);
      for (const marker of markerLoss && index === 1 ? [] : correction.markers) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) rgb[((marker.position.y * 100 + y) * 100 + marker.position.x * 100 + shift + x) * 3 + 1] = 255;
      // The selected-car region contains actual textured appearance, not a blank patch.
      for (let y = 40; y < 50; y++) for (let x = 40 + shift; x < 50 + shift; x++) {
        const pixel = (y * 100 + x) * 3; rgb[pixel] = 180; rgb[pixel + 1] = (x - shift + y) % 2 ? 40 : 90; rgb[pixel + 2] = 60;
      }
      return rgb;
    });
    const raw = join(root, "fixture.rgb"); const video = join(root, "fixture.mkv");
    await writeFile(raw, Buffer.concat(frames));
    execFileSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "100x100", "-framerate", "10", "-i", raw, "-c:v", "ffv1", video]);
    const app = createLocalApp(workflow, persistence, artifacts, videos, (id, signal) => executeLocalStabilization(id, workflow, persistence, artifacts, { signal, resolveVideoPath: async (reference) => videos.resolvePath(reference) }));
    const body = new File([await readFile(video)], "fixture.mkv", { type: "video/x-matroska" });
    const imported = await (await app.request("http://localhost/local-videos", { method: "POST", body, headers: { "x-video-name": encodeURIComponent(body.name), "content-type": body.type, "x-video-last-modified": String(body.lastModified) } })).json() as Awaited<ReturnType<LocalVideoStore["importVideo"]>>;
    const draft = await (await app.request("http://localhost/analyses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...imported, videoStorage: "local-disk", videoName: "fixture.mkv" }) })).json() as { id: string };
    expect((await app.request(`http://localhost/analyses/${draft.id}/calibration/start`, { method: "POST" })).status).toBe(200);
    expect((await app.request(`http://localhost/analyses/${draft.id}/correction-sets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(correction) })).status).toBe(201);
    expect((await app.request(`http://localhost/analyses/${draft.id}/queue`, { method: "POST" })).status).toBe(200);
    expect((await app.request(`http://localhost/analyses/${draft.id}/start`, { method: "POST" })).status).toBe(200);
    await expect.poll(async () => ((await (await app.request(`http://localhost/analyses/${draft.id}`)).json()) as { state: string }).state, { timeout: 10_000 }).toBe(markerLoss ? "needs_correction" : "completed");
    const diagnostic = await (await app.request(`http://localhost/analyses/${draft.id}/artifacts`)).json() as { stabilization: unknown; run: unknown; artifacts: unknown[] };
    expect(diagnostic.stabilization).toEqual({ totalFrames: 2, usableFrames: markerLoss ? 1 : 2, unusableRegions: markerLoss ? [{ startFrame: 1, endFrame: 1, reason: "stabilization quality rejected" }] : [] });
    expect(diagnostic.run).toMatchObject({ status: markerLoss ? "needs_correction" : "completed", frame: 1 });
    const output = await artifacts.readPublished(draft.id);
    if (markerLoss) expect(output?.transforms[1].quality.usable).toBe(false);
    else expect(output?.transforms[1].matrix[2]).toBeCloseTo(-3);
    expect(diagnostic.artifacts).toHaveLength(4);
  });

  it("rejects source replacement and corrupt checkpoints, and hides historical output during a fresh run", async () => {
    const { persistence, artifacts, videos, workflow } = await fixture();
    const input = await videos.importVideo(new File(["original"], "race.mp4"), "immutable-source");
    await expect(videos.importVideo(new File(["replacement"], "race.mp4"), "immutable-source")).rejects.toThrow();
    expect(await readFile(videos.resolvePath(input.videoPath), "utf8")).toBe("original");
    const draft = await workflow.createDraft({ ...input, videoName: "race.mp4", videoStorage: "local-disk" });
    await workflow.startCalibration(draft.id);
    const accepted = await workflow.createAndAcceptCorrectionSet(draft.id, correction);
    const run = await persistence.startRun(draft.id, accepted.id, "fixture-v1");
    await artifacts.commit(run, { markerObservations: [], transforms: [] });
    expect(await artifacts.readPublished(draft.id)).toBeDefined();
    await persistence.updateRun(run.id, { status: "completed" });
    await persistence.startRun(draft.id, accepted.id, "fixture-v1", true);
    expect(await artifacts.readPublished(draft.id)).toBeUndefined();
    await artifacts.writeCheckpoint(run, { markerObservations: [], transforms: [] });
    await writeFile(join(artifacts.root, run.id, "checkpoint.json"), JSON.stringify({ correctionSetId: accepted.id, providerVersion: "fixture-v1", artifacts: { markerObservations: [], transforms: [{ frame: 0, model: "affine", matrix: [null], quality: { usable: true } }] } }));
    await expect(artifacts.readCheckpoint(run)).rejects.toThrow("invalid stabilization transform checkpoint");
    const valid = { frame: 0, model: "affine", matrix: [1, 0, 0, 0, 1, 0], quality: { enoughMarkers: true, reprojectionValid: true, inliersValid: true, scaleValid: true, rotationValid: true, cropValid: true, usable: true } };
    await writeFile(join(artifacts.root, run.id, "checkpoint.json"), JSON.stringify({ correctionSetId: accepted.id, providerVersion: "fixture-v1", artifacts: { markerObservations: [], transforms: [valid, { ...valid, frame: 2 }] } }));
    await expect(artifacts.readCheckpoint(run)).rejects.toThrow("invalid stabilization transform checkpoint");
    const app = createLocalApp(workflow, persistence, artifacts, videos, async () => undefined);
    expect((await app.request("http://localhost/analyses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoPath: "local-disk://missing", videoStorage: "local-disk", videoName: "missing.mp4" }) })).status).toBe(400);
  });

});
