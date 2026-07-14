import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { InMemoryTimingStore, normalizeDriverName, parseDriverResult, parseDrivers, parseEvents, parseRaces, parseTrackList } from "../src/timing";
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

  it("extracts the clean driver name and View Laps URL from LiveRC result rows", () => {
    const html = '<tr><td>2</td><td>2</td><td>BEN HALVERSON</td><td><a href="?p=view_driver_laps&id=2">View Laps</a></td></tr>';
    expect(parseDrivers(html)).toEqual([{ name: "BEN HALVERSON", normalizedName: "ben halverson", url: "?p=view_driver_laps&id=2" }]);
  });

  it("does not expose a placeholder hash as a driver detail URL", () => {
    expect(parseDrivers('<tr><td>4</td><td>4 BEN HALVERSON</td><td><a href="#">View Laps</a></td></tr>')).toEqual([{ name: "BEN HALVERSON", normalizedName: "ben halverson" }]);
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

  it("finds a hyphenated LiveRC track when the query omits punctuation", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 200, html: '<a href="https://norcalhobbies.liverc.com/">Nor-Cal Hobbies</a>' }),
    });
    const response = await app.request("/timing/tracks?query=norcal%20hobbies");
    expect(await response.json()).toEqual({ tracks: [{ host: "norcalhobbies.liverc.com", name: "Nor-Cal Hobbies", url: "https://norcalhobbies.liverc.com/" }] });
  });
});
