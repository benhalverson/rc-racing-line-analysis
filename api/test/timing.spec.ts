import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { InMemoryAnalysisStore } from "../src/store";
import { fetchTimingPage, InMemoryTimingStore, normalizeDriverName, normalizeTrackUrl, parseDriverResult, parseDrivers, parseEvents, parseRaces, parseTrackList } from "../src/timing";
import { AnalysisWorkflow } from "../src/workflow";

const tracksHtml = '<a href="https://rcra.liverc.com/">RCRA</a><a href="https://other.liverc.com/">Other Track</a>';
const raceHtml = '<a href="/results/?id=44&p=view_race_result">Buggy Heat 2/7</a>';
const driverHtml = '<table><tr><td>Alex Racer</td>  <td>1</td></tr></table><div>Lap 1: 18.42s</div><div>Lap 2: 17.98s</div>';
const timingRequest = {
  trackHost: "rcra.liverc.com", trackName: "RCRA", trackUrl: "https://rcra.liverc.com/", eventName: "Nationals",
  eventUrl: "https://rcra.liverc.com/events/1", raceId: "race-4", raceLabel: "Buggy Heat 2/7", roundLabel: "Qualifier",
  classLabel: "Buggy", raceUrl: "https://rcra.liverc.com/results/?id=44&p=view_race_result", driverName: "Alex Racer", driverId: "driver-7",
};

describe("LiveRC timing adapter", () => {
  it("retries a transient network failure once", async () => {
    let attempts = 0;
    const page = await fetchTimingPage(async (url) => {
      attempts += 1;
      if (attempts === 1) throw new Error("network unavailable");
      return { url, status: 200, html: "ok" };
    }, "https://norcalhobbies.liverc.com/events/");
    expect(attempts).toBe(2);
    expect(page.html).toBe("ok");
  });

  it("returns 502 after two transient failures", async () => {
    let attempts = 0;
    await expect(fetchTimingPage(async () => {
      attempts += 1;
      return { url: "https://norcalhobbies.liverc.com/events/", status: 503, html: "" };
    }, "https://norcalhobbies.liverc.com/events/")).rejects.toThrow("LiveRC returned HTTP 503");
    expect(attempts).toBe(2);
  });

  it("does not retry a client error", async () => {
    let attempts = 0;
    await expect(fetchTimingPage(async () => {
      attempts += 1;
      return { url: "https://norcalhobbies.liverc.com/events/", status: 404, html: "" };
    }, "https://norcalhobbies.liverc.com/events/")).rejects.toThrow("LiveRC returned HTTP 404");
    expect(attempts).toBe(1);
  });

  it("discovers tracks, events, and race-result links without slugifying names", () => {
    expect(parseTrackList(tracksHtml).map((track) => track.host)).toEqual(["rcra.liverc.com", "other.liverc.com"]);
    expect(parseEvents('<a href="https://live.liverc.com/events/calendar/">Calendar</a><a href="/results/?id=44&p=view_event">2026 Nationals</a><a href="/results/?p=view_event&id=44">Duplicate</a><a href="https://other.liverc.com/results/?id=99&p=view_event">Other</a><a href="/events/">Past Events</a><a href="/results/?id=0&p=view_event">Placeholder</a>', "https://rcra.liverc.com/")).toEqual([{ name: "2026 Nationals", url: "https://rcra.liverc.com/results/?id=44&p=view_event" }]);
    expect(parseRaces(raceHtml, "https://rcra.liverc.com/results/")[0]).toMatchObject({ id: "44", label: "Buggy Heat 2/7" });
  });

  it("keeps only exact same-host race-result links and preserves the first label", () => {
    const html = [
      '<a href="/results/?id=44&p=view_race_result">First label</a>',
      '<a href="/results/?id=44&p=view_race_result">Duplicate label</a>',
      '<a href="/results/?id=0&p=view_race_result">Placeholder</a>',
      '<a href="/results/?id=45&p=view_event">Event</a>',
      '<a href="/results/?id=46&p=view_race_result">Aggregate result</a>',
      '<a href="/results/?id=bad&p=view_race_result">Malformed</a>',
      '<a href="https://other.liverc.com/results/?id=47&p=view_race_result">External track</a>',
      '<a href="https://example.com/results/?id=48&p=view_race_result">External</a>',
    ].join('');
    expect(parseRaces(html, "https://rcra.liverc.com/events/1")).toEqual([
      { id: "44", label: "First label", url: "https://rcra.liverc.com/results/?id=44&p=view_race_result" },
      { id: "46", label: "Aggregate result", url: "https://rcra.liverc.com/results/?id=46&p=view_race_result" },
    ]);
  });

  it("resolves duplicate driver names by exact ID and rejects an ambiguous name", () => {
    const html = `<script>
      racerLaps[101] = { 'driverName': 'Alex Racer', 'laps': [ { 'lapNum': '1', 'pos': '1', 'time': '18.1', 'pace': '1/0:18.1' } ] };
      racerLaps[202] = { 'driverName': 'Alex Racer', 'laps': [ { 'lapNum': '1', 'pos': '2', 'time': '19.2', 'pace': '2/0:19.2' } ] };
    </script>`;
    expect(() => parseDriverResult(html, "Alex Racer")).toThrow("ambiguous");
    expect(parseDriverResult(html, "Alex Racer", "202")).toMatchObject({ driverId: "202", laps: [{ lapTimeSeconds: 19.2 }] });
    expect(() => parseDriverResult(html, "Alex Racer", "999")).toThrow("not found");
  });

  it("normalizes names for matching while preserving the displayed name", () => {
    expect(normalizeDriverName(" José  Racer ")).toBe("jose racer");
    expect(parseDriverResult(driverHtml, "alex racer")).toMatchObject({ driverName: "Alex Racer", laps: [{ lapNumber: 1, lapTimeSeconds: 18.42 }, { lapNumber: 2, lapTimeSeconds: 17.98 }] });
  });

  it("extracts the clean driver name and View Laps URL from LiveRC result rows", () => {
    const html = '<tr><td>2</td><td>2</td><td>BEN HALVERSON</td><td><a href="?p=view_driver_laps&id=2">View Laps</a></td></tr>';
    expect(parseDrivers(html)).toEqual([{ name: "BEN HALVERSON", normalizedName: "ben halverson", driverId: "2" }]);
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
		const html = `<script>racerLaps[566775] = { 'driverName' : 'BEN HALVERSON', 'laps' : [ { 'lapNum' : '1', 'pos' : '1', 'time' : '28.58', 'pace' : '11/5:14.385' }, { 'lapNum' : '2', 'pos' : '2', 'time' : '22.966', 'pace' : '12/5:09.279' }, { 'lapNum' : '3', 'pos' : '3', 'time' : '23.1', 'pace' : '13/5:10.000' }, { 'lapNum' : '4', 'pos' : '4', 'time' : '24.2', 'pace' : '14/5:11.000' } ] };</script>`;
		expect(parseDriverResult(html, "BEN HALVERSON")).toMatchObject({ driverId: "566775", laps: [
			{ lapNumber: 1, lapTimeSeconds: 28.58, statusText: "11/5:14.385 · P1" },
			{ lapNumber: 2, lapTimeSeconds: 22.966, statusText: "12/5:09.279 · P2" },
			{ lapNumber: 3, lapTimeSeconds: 23.1, statusText: "13/5:10.000 · P3" },
			{ lapNumber: 4, lapTimeSeconds: 24.2, statusText: "14/5:11.000 · P4" },
		] });
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

  it("preserves the complete canonical request through POST and GET", async () => {
    const store = new InMemoryTimingStore();
    const timing = { store, fetch: async (url: string) => ({ url, status: 200, html: driverHtml }) };
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, timing);
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(timingRequest) });
    expect(response.status).toBe(201);
    const imported = await response.json() as Record<string, unknown>;
    const retrieved = await app.request(`/timing/imports/${imported.id}`);
    expect(await retrieved.json()).toEqual(imported);
    expect(imported).toMatchObject({ ...timingRequest, driverName: "Alex Racer", normalizedDriverName: "alex racer" });
  });

  it.each([undefined, null, "", "   "]) ("normalizes raceId and driverId value %j to null", async (id) => {
    let fetchCount = 0;
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => { fetchCount += 1; return { url, status: 200, html: driverHtml }; },
    });
    const request = { ...timingRequest, raceId: id, driverId: id };
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ raceId: null, driverId: null });
    expect(fetchCount).toBe(1);
  });

  it("rejects unknown fields before fetching or persisting", async () => {
    let fetchCount = 0;
    const store = new InMemoryTimingStore();
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store,
      fetch: async (url: string) => { fetchCount += 1; return { url, status: 200, html: driverHtml }; },
    });
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...timingRequest, unexpected: "value" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "all selected track, event, race, and driver fields are required" });
    expect(fetchCount).toBe(0);
    expect(await store.getTimingImport("anything")).toBeUndefined();
  });

  it.each([123, true, {}, []]) ("rejects invalid ID type %j", async (id) => {
    let fetchCount = 0;
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => { fetchCount += 1; return { url, status: 200, html: driverHtml }; },
    });
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...timingRequest, raceId: id }) });
    expect(response.status).toBe(400);
    expect(fetchCount).toBe(0);
  });

  it("preserves the required-field validation response", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 200, html: driverHtml }),
    });
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...timingRequest, driverName: " " }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "all selected track, event, race, and driver fields are required" });
  });

  it("returns consistent upstream errors for races and drivers", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 503, html: "" }),
    });
    const races = await app.request("/timing/races?eventUrl=https%3A%2F%2Frcra.liverc.com%2Fevents%2F1");
    const drivers = await app.request("/timing/drivers?raceUrl=https%3A%2F%2Frcra.liverc.com%2Fresults%2F%3Fid%3D44%26p%3Dview_race_result");
    expect(races.status).toBe(502);
    expect(await races.json()).toEqual({ error: "LiveRC returned HTTP 503" });
    expect(drivers.status).toBe(502);
    expect(await drivers.json()).toEqual({ error: "LiveRC returned HTTP 503" });
  });

  it("returns upstream import errors as bad gateway without persisting", async () => {
    const store = new InMemoryTimingStore();
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store,
      fetch: async (url: string) => ({ url, status: 503, html: "" }),
    });
    const response = await app.request("/timing/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(timingRequest),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "LiveRC returned HTTP 503" });
    expect(await store.listTimingImports(20)).toEqual([]);
  });

  it("discovers races and drivers through the public API boundary", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => {
        if (url.endsWith("/events/1")) return { url, status: 200, html: raceHtml };
        return { url, status: 200, html: '<tr><td>2</td><td>2</td><td>BEN HALVERSON</td><td><a href="?p=view_driver_laps&id=2">View Laps</a></td></tr>' };
      },
    });
    const races = await app.request("/timing/races?eventUrl=https%3A%2F%2Frcra.liverc.com%2Fevents%2F1");
    expect(races.status).toBe(200);
    expect(await races.json()).toEqual({ races: [{ id: "44", label: "Buggy Heat 2/7", url: "https://rcra.liverc.com/results/?id=44&p=view_race_result" }] });
    const drivers = await app.request("/timing/drivers?raceUrl=https%3A%2F%2Frcra.liverc.com%2Fresults%2F%3Fid%3D44%26p%3Dview_race_result");
    expect(drivers.status).toBe(200);
    expect(await drivers.json()).toEqual({ drivers: [{ name: "BEN HALVERSON", normalizedName: "ben halverson", driverId: "2" }] });
  });

  it("rejects an import track URL outside the permitted LiveRC hosts before fetching", async () => {
    let fetchCount = 0;
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => { fetchCount += 1; return { url, status: 200, html: driverHtml }; },
    });
    const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...timingRequest, trackUrl: "https://example.com/" }) });
    expect(response.status).toBe(400);
    expect(fetchCount).toBe(0);
  });

  it("hydrates a saved import without contacting LiveRC", async () => {
    const store = new InMemoryTimingStore();
    let fetchCount = 0;
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store,
      fetch: async (url: string) => { fetchCount += 1; return { url, status: 200, html: driverHtml }; },
    });
    const created = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(timingRequest) });
    const imported = await created.json() as { id: string; laps: unknown[]; sourceHash: string };
    const before = fetchCount;
    const fetched = await app.request(`/timing/imports/${imported.id}`);
    expect(fetched.status).toBe(200);
    expect(fetchCount).toBe(before);
    expect(await fetched.json()).toMatchObject({ id: imported.id, sourceHash: imported.sourceHash, laps: imported.laps });
  });

  it("lists lightweight persisted imports newest first and respects the bounded limit", async () => {
    const store = new InMemoryTimingStore();
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store,
      fetch: async (url: string) => ({ url, status: 200, html: driverHtml }),
    });
    for (const raceLabel of ["Older", "Newer"]) {
      const raceId = raceLabel === "Older" ? "44" : "45";
      const response = await app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...timingRequest, raceLabel, raceId, raceUrl: `https://rcra.liverc.com/results/?id=${raceId}&p=view_race_result` }) });
      expect(response.status).toBe(201);
      if (raceLabel === "Older") await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const response = await app.request("/timing/imports?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as { imports: Array<Record<string, unknown>> };
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).not.toHaveProperty("laps");
    expect(body.imports[0]).toMatchObject({ raceLabel: "Newer", classLabel: "Buggy", driverName: "Alex Racer" });
  });

  it("finds a hyphenated LiveRC track when the query omits punctuation", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 200, html: '<a href="https://norcalhobbies.liverc.com/">Nor-Cal Hobbies</a>' }),
    });
    const response = await app.request("/timing/tracks?query=norcal%20hobbies");
    expect(await response.json()).toEqual({ tracks: [{ host: "norcalhobbies.liverc.com", name: "Nor-Cal Hobbies", url: "https://norcalhobbies.liverc.com/" }] });
  });

  it("returns a gateway error when LiveRC cannot be reached", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async () => { throw new Error("network unavailable"); },
    });
    const response = await app.request("/timing/tracks?query=norcal%20hobbies");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Unable to reach LiveRC" });
  });

  it("skips malformed and unrelated track links", async () => {
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, {
      store: new InMemoryTimingStore(),
      fetch: async (url: string) => ({ url, status: 200, html: '<a href="%">Broken</a><a href="https://example.com/">Unrelated</a><a href="https://norcalhobbies.liverc.com/path">Nor-Cal Hobbies</a>' }),
    });
    const response = await app.request("/timing/tracks?query=norcal%20hobbies");
    expect(response.status).toBe(200);
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
