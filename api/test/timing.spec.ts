import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { InMemoryTimingStore, normalizeDriverName, normalizeTrackUrl, parseDriverResult, parseDrivers, parseEvents, parseRaces, parseTrackList } from "../src/timing";
import { AnalysisWorkflow } from "../src/workflow";

const tracksHtml = '<a href="https://rcra.liverc.com/">RCRA</a><a href="https://other.liverc.com/">Other Track</a>';
const raceHtml = '<a href="/results/?id=44&p=view_race_result">Buggy Heat 2/7</a>';
const driverHtml = '<table><tr><td>Alex Racer</td>  <td>1</td></tr></table><div>Lap 1: 18.42s</div><div>Lap 2: 17.98s</div>';

describe("LiveRC timing adapter", () => {
  it("discovers tracks, events, and race-result links without slugifying names", () => {
    expect(parseTrackList(tracksHtml).map((track) => track.host)).toEqual(["rcra.liverc.com", "other.liverc.com"]);
    expect(parseEvents('<a href="https://live.liverc.com/events/calendar/">Calendar</a><a href="/results/?id=44&p=view_event">2026 Nationals</a><a href="/results/?p=view_event&id=44">Duplicate</a><a href="https://other.liverc.com/results/?id=99&p=view_event">Other</a><a href="/events/">Past Events</a><a href="/results/?id=0&p=view_event">Placeholder</a>', "https://rcra.liverc.com/")).toEqual([{ name: "2026 Nationals", url: "https://rcra.liverc.com/results/?id=44&p=view_event" }]);
    expect(parseRaces(raceHtml, "https://rcra.liverc.com/results/")[0]).toMatchObject({ id: "44", label: "Buggy Heat 2/7" });
  });

  it("normalizes names for matching while preserving the displayed name", () => {
    expect(normalizeDriverName(" José  Racer ")).toBe("jose racer");
    expect(parseDriverResult(driverHtml, "alex racer")).toMatchObject({ driverName: "Alex Racer", laps: [{ lapNumber: 1, lapTimeSeconds: 18.42 }, { lapNumber: 2, lapTimeSeconds: 17.98 }] });
  });

  it("extracts the clean driver name and View Laps URL from LiveRC result rows", () => {
    const html = '<tr><td>2</td><td>2</td><td>BEN HALVERSON</td><td><a href="?p=view_driver_laps&id=2">View Laps</a></td></tr>';
    expect(parseDrivers(html)).toEqual([{ name: "BEN HALVERSON", normalizedName: "ben halverson" }]);
  });

  it("does not expose a placeholder hash as a driver detail URL", () => {
    expect(parseDrivers('<tr><td>4</td><td>4 BEN HALVERSON</td><td><a href="#" data-driver-id="566775">View Laps</a></td></tr>')).toEqual([{ name: "BEN HALVERSON", normalizedName: "ben halverson", driverId: "566775" }]);
  });

  it("rejects a race summary instead of treating aggregate text as lap data", () => {
    expect(() => parseDriverResult('<tr><td>BEN HALVERSON</td><td>16/5:04.787</td></tr>', "BEN HALVERSON")).toThrow("no individual lap times");
  });

  it("parses individual lap rows from the LiveRC View Laps detail table", () => {
    const html = '<h1>BEN HALVERSON</h1><table><tr><th>#</th><th>Time</th><th>Pace</th><th>Pos</th></tr><tr><td>1</td><td>28.58</td><td>11/5:14.385</td><td>4th</td></tr><tr><td>2</td><td>22.966</td><td>12/5:09.279</td><td>4th</td></tr></table>';
    expect(parseDriverResult(html, "BEN HALVERSON")).toMatchObject({ driverName: "BEN HALVERSON", laps: [{ lapNumber: 1, lapTimeSeconds: 28.58, statusText: "4th" }, { lapNumber: 2, lapTimeSeconds: 22.966, statusText: "4th" }] });
  });

  it("parses LiveRC's embedded racerLaps data from the race result page", () => {
    const html = `<script>racerLaps[566775] = { 'driverName' : 'BEN HALVERSON', 'laps' : [ { 'lapNum' : '1', 'pos' : '4', 'time' : '28.58', 'pace' : '11/5:14.385' }, { 'lapNum' : '2', 'pos' : '4', 'time' : '22.966', 'pace' : '12/5:09.279' } ] };</script>`;
    expect(parseDriverResult(html, "BEN HALVERSON")).toMatchObject({ driverId: "566775", laps: [{ lapNumber: 1, lapTimeSeconds: 28.58 }, { lapNumber: 2, lapTimeSeconds: 22.966 }] });
  });

  it("exposes selected-driver imports and rejects pages without individual laps", async () => {
    const store = new InMemoryTimingStore();
    const timing = { store, fetch: async (url: string) => ({ url, status: 200, html: driverHtml }) };
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, timing);
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trackHost: "rcra.liverc.com", trackName: "RCRA", trackUrl: "https://rcra.liverc.com/", eventName: "Nationals", eventUrl: "https://rcra.liverc.com/events/1", raceLabel: "Buggy Heat 2/7", roundLabel: "Qualifier", classLabel: "Buggy", raceUrl: "https://rcra.liverc.com/results/?id=44&p=view_race_result", driverName: "Alex Racer", driverId: "driver-7" }) });
    expect(response.status).toBe(201);
    const imported = await response.json() as { id: string; source: string; normalizedDriverName: string; laps: unknown[]; sourceHash: string };
    expect(imported).toMatchObject({ source: "liverc", normalizedDriverName: "alex racer", raceId: null, driverId: "driver-7", parserVersion: "liverc-html-v1" });
    expect(imported.laps).toHaveLength(2);
    expect(imported.sourceHash).toHaveLength(64);
    const retrieved = await app.request(`/timing/imports/${imported.id}`);
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toMatchObject({ id: imported.id, source: "liverc", raceId: null, driverId: "driver-7", parserVersion: "liverc-html-v1", sourceHash: imported.sourceHash, laps: [{ lapNumber: 1, lapTimeSeconds: 18.42, lapTimeText: "18.42", valid: true, statusText: null }, { lapNumber: 2, lapTimeSeconds: 17.98, lapTimeText: "17.98", valid: true, statusText: null }] });
  });

  it("finds a hyphenated LiveRC track when the query omits punctuation", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 200, html: '<a href="https://norcalhobbies.liverc.com/">Nor-Cal Hobbies</a>' }),
    });
    const response = await app.request("/timing/tracks?query=norcal%20hobbies");
    expect(await response.json()).toEqual({ tracks: [{ host: "norcalhobbies.liverc.com", name: "Nor-Cal Hobbies", url: "https://norcalhobbies.liverc.com/" }] });
  });

  it("loads the selected track archive when discovering events", async () => {
    let requestedUrl = "";
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => { requestedUrl = url; return { url, status: 200, html: '<a href="/results/?id=44&p=view_event">2026 Nationals</a>' }; },
    });
    const response = await app.request("/timing/events?trackUrl=https%3A%2F%2Fnorcalhobbies.liverc.com%2F");
    expect(requestedUrl).toBe("https://norcalhobbies.liverc.com/events/");
    expect(await response.json()).toEqual({ events: [{ name: "2026 Nationals", url: "https://norcalhobbies.liverc.com/results/?id=44&p=view_event" }] });
  });

  it("normalizes a valid track URL before loading its archive", async () => {
    expect(normalizeTrackUrl(" HTTPS://NorCalHobbies.LiveRC.com/some/path?stale=1 ")).toBe("https://norcalhobbies.liverc.com/");
  });

  it.each(["", "not a url", "https://example.com/", "https://live.liverc.com/"]) ("rejects invalid track URL %j", async (trackUrl) => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, { store: new InMemoryTimingStore(), fetch: async (url: string) => ({ url, status: 200, html: "" }) });
    const response = await app.request(`/timing/events${trackUrl ? `?trackUrl=${encodeURIComponent(trackUrl)}` : ""}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: trackUrl ? "trackUrl must be a valid LiveRC track URL" : "trackUrl is required" });
  });
});
