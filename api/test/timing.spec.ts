import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { InMemoryTimingStore, normalizeDriverName, parseDriverResult, parseEvents, parseRaces, parseTrackList } from "../src/timing";
import { AnalysisWorkflow } from "../src/workflow";

const tracksHtml = '<a href="https://rcra.liverc.com/">RCRA</a><a href="https://other.liverc.com/">Other Track</a>';
const raceHtml = '<a href="/results/?id=44&p=view_race_result">Buggy Heat 2/7</a>';
const driverHtml = '<table><tr><td>Alex Racer</td>  <td>1</td></tr></table><div>Lap 1: 18.42s</div><div>Lap 2: 17.98s</div>';

describe("LiveRC timing adapter", () => {
  it("discovers tracks, events, and race-result links without slugifying names", () => {
    expect(parseTrackList(tracksHtml).map((track) => track.host)).toEqual(["rcra.liverc.com", "other.liverc.com"]);
    expect(parseEvents('<a href="/events/2026">2026 Nationals</a>', "https://rcra.liverc.com/")).toEqual([{ name: "2026 Nationals", url: "https://rcra.liverc.com/events/2026" }]);
    expect(parseRaces(raceHtml, "https://rcra.liverc.com/results/")[0]).toMatchObject({ id: "44", label: "Buggy Heat 2/7" });
  });

  it("normalizes names for matching while preserving the displayed name", () => {
    expect(normalizeDriverName(" José  Racer ")).toBe("jose racer");
    expect(parseDriverResult(driverHtml, "alex racer")).toMatchObject({ driverName: "Alex Racer", laps: [{ lapNumber: 1, lapTimeSeconds: 18.42 }, { lapNumber: 2, lapTimeSeconds: 17.98 }] });
  });

  it("exposes selected-driver imports and rejects pages without individual laps", async () => {
    const store = new InMemoryTimingStore();
    const timing = { store, fetch: async (url: string) => ({ url, status: 200, html: driverHtml }) };
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, timing);
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trackHost: "rcra.liverc.com", trackName: "RCRA", trackUrl: "https://rcra.liverc.com/", eventName: "Nationals", eventUrl: "https://rcra.liverc.com/events/1", raceLabel: "Buggy Heat 2/7", roundLabel: "Qualifier", classLabel: "Buggy", raceUrl: "https://rcra.liverc.com/results/?id=44&p=view_race_result", driverName: "Alex Racer" }) });
    expect(response.status).toBe(201);
    const imported = await response.json() as { id: string; source: string; normalizedDriverName: string; laps: unknown[]; sourceHash: string };
    expect(imported).toMatchObject({ source: "liverc", normalizedDriverName: "alex racer" });
    expect(imported.laps).toHaveLength(2);
    expect(imported.sourceHash).toHaveLength(64);
    expect((await app.request(`/timing/imports/${imported.id}`)).status).toBe(200);
  });
});
