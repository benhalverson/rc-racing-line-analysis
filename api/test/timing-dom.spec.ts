import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { browserTimingFetcher } from "../src/timing-browser";
import { InMemoryAnalysisStore } from "../src/store";
import { InMemoryTimingStore, type TimingImport, type TimingFetcher } from "../src/timing";
import { AnalysisWorkflow } from "../src/workflow";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/timing/${name}.html`, import.meta.url), "utf8");
const input = { trackHost: "rcra.liverc.com", trackName: "RCRA & Club", trackUrl: "https://rcra.liverc.com/", eventName: "Summer Race", eventUrl: "https://rcra.liverc.com/results/?p=view_event&id=11", raceId: "44", raceLabel: "Buggy Heat 2/7", roundLabel: "Qualifier", classLabel: "Buggy", raceUrl: "https://rcra.liverc.com/results/?id=44&p=view_race_result", driverName: "José O'Brien", driverId: "101" };
/** Exercise the transport with its public workflow and persistence ports. */
function setup(html: string, browser?: TimingFetcher) {
  const store = new InMemoryTimingStore();
  const fetch = vi.fn(async (url: string) => ({ url, status: 200, html }));
  const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, { store, fetch, browser });
  const post = (request = input) => app.request("/timing/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  return { app, store, fetch, post };
}

describe("DOM timing public behavior", () => {
  it("decodes attributes/entities and keeps venue, event and repeated heat identities", async () => {
    const { app } = setup(fixture("dom-links"));
    expect(await (await app.request("/timing/tracks")).json()).toEqual({ tracks: [{ host: "rcra.liverc.com", name: "RCRA & Club", url: "https://rcra.liverc.com/" }, { host: "other.liverc.com", name: "RCRA & Club", url: "https://other.liverc.com/" }, { host: "other.liverc.com", name: "Other venue", url: "https://other.liverc.com/" }] });
    expect(await (await app.request(`/timing/events?trackUrl=${encodeURIComponent(input.trackUrl)}`)).json()).toEqual({ events: [{ name: "Summer Race", url: input.eventUrl }] });
    const response = await app.request(`/timing/races?eventUrl=${encodeURIComponent(input.eventUrl)}`);
    expect(await response.json()).toMatchObject({ races: [{ id: "44", label: "Buggy Heat 2/7", classLabel: "Buggy" }, { id: "45", label: "Buggy Heat 3/7", classLabel: "Buggy" }] });
  });

  it("imports literal telemetry and preserves provenance/offline retrieval without executing scripts", async () => {
    const browser = vi.fn();
    const { app, fetch, post } = setup(fixture("dom-race"), browser);
    const response = await post();
    expect(response.status).toBe(201);
    const imported = await response.json() as TimingImport;
    expect(imported).toMatchObject({ ...input, parserVersion: "liverc-dom-v2", laps: [{ lapNumber: 1, lapTimeSeconds: 18.42 }, { lapNumber: 2, lapTimeSeconds: 17.98 }] });
    expect(imported.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(imported).not.toHaveProperty("html");
    expect((globalThis as Record<string, unknown>).remoteExecuted).toBeUndefined();
    expect(await (await app.request(`/timing/imports/${imported.id}`)).json()).toEqual(imported);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
    expect(await (await app.request(`/timing/drivers?raceUrl=${encodeURIComponent(input.raceUrl)}`)).json()).toEqual({ drivers: [{ name: "José O'Brien", normalizedName: "jose o brien", driverId: "101" }, { name: "José O'Brien", normalizedName: "jose o brien", driverId: "202" }] });
  });

  it.each(["null", "999"]) ("rejects ambiguous or absent selected result %s", async (id) => {
    const { post, store } = setup(fixture("dom-race"));
    const response = await post({ ...input, driverId: id === "null" ? null as unknown as string : id });
    expect(response.status).toBe(502);
    expect(await store.listTimingImports(10)).toEqual([]);
  });

  it.each(["(() => { globalThis.remoteExecuted = true; return []; })()", "[{ get time() { return 18; }, lapNum: 1 }]", "[...[]]"]) ("rejects executable lap expression %s without rendering", async (expression) => {
    const browser = vi.fn();
    const { post } = setup(`<script>racerLaps[101] = { driverName: "José O'Brien", laps: ${expression} };</script>`, browser);
    expect((await post()).status).toBe(502);
    expect(browser).not.toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>).remoteExecuted).toBeUndefined();
  });

  it("renders an incomplete shell once and hashes the HTML actually parsed", async () => {
    const browser = vi.fn(async (url: string) => ({ url, status: 200, html: fixture("dom-race") }));
    const { post, fetch } = setup("<main id='app'></main><script src='/app.js'></script>", browser);
    const response = await post();
    expect(response.status).toBe(201);
    const direct = await setup(fixture("dom-race")).post();
    expect((await response.json() as TimingImport).sourceHash).toBe((await direct.json() as TimingImport).sourceHash);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browser).toHaveBeenCalledExactlyOnceWith(input.raceUrl);
  });

  it.each(["<table><tr><th>Driver</th></tr></table>", "<main>No results available</main>", '<script>racerLaps[101] = { driverName: "José O\'Brien", laps: [] };</script>']) ("does not render a legitimate empty or lapless result", async (html) => {
    const browser = vi.fn();
    const { app, post } = setup(html, browser);
    const response = await app.request(`/timing/drivers?raceUrl=${encodeURIComponent(input.raceUrl)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drivers: [] });
    expect((await post()).status).toBe(502);
    expect(browser).not.toHaveBeenCalled();
  });

  it.each([429, 503])("reports Browser Run HTTP %s without retry or persistence", async (status) => {
    const binding = { quickAction: vi.fn(async () => new Response("failure", { status })) };
    const { post, store } = setup("<main id='app'></main>", browserTimingFetcher(binding));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: `Browser Run returned HTTP ${status}` });
    expect(binding.quickAction).toHaveBeenCalledTimes(1);
    expect(await store.listTimingImports(10)).toEqual([]);
  });

  it("uses the optional /content binding with only the selected timing URL", async () => {
    const binding = { quickAction: vi.fn(async () => new Response(fixture("dom-race"), { headers: { "content-type": "text/html" } })) };
    expect((await setup("<main></main>", browserTimingFetcher(binding)).post()).status).toBe(201);
    expect(binding.quickAction).toHaveBeenCalledExactlyOnceWith("content", { url: input.raceUrl, gotoOptions: { waitUntil: "networkidle0", timeout: 10_000 } });
    expect(browserTimingFetcher()).toBeUndefined();
  });

  it("bounds a stalled browser and clears its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { post } = setup("<main></main>", async () => new Promise(() => {}));
      const response = post();
      await vi.advanceTimersByTimeAsync(15_001);
      expect((await response).status).toBe(502);
      expect(await (await response).json()).toEqual({ error: "Timing upstream timed out" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("renders the track directory through the binding and accepts a JSON content envelope", async () => {
    const binding = { quickAction: vi.fn(async () => Response.json({ success: true, result: '<a href="https://rcra.liverc.com/">RCRA</a>' })) };
    const { app } = setup("<main></main>", browserTimingFetcher(binding));
    const response = await app.request("/timing/tracks");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tracks: [{ host: "rcra.liverc.com" }] });
    expect(binding.quickAction.mock.calls[0]).toEqual(["content", { url: "https://live.liverc.com/", gotoOptions: { waitUntil: "networkidle0", timeout: 10_000 } }]);
  });

  it("does not render a spaced/commented literal assignment with legitimately missing laps", async () => {
    const browser = vi.fn();
    const { post } = setup(`<script>racerLaps /* data */ [101] = { driverName: "José O'Brien", laps: [] };</script>`, browser);
    expect((await post()).status).toBe(502);
    expect(browser).not.toHaveBeenCalled();
  });

  it.each(["true", "null", "'0x10'", "[]", "{}"])("rejects malformed telemetry numeric value %s without persistence", async (time) => {
    const { post, store } = setup(`<script>racerLaps[101] = { driverName: "José O'Brien", laps: [{ lapNum: 1, time: ${time} }] };</script>`);
    expect((await post()).status).toBe(502);
    expect(await store.listTimingImports(10)).toEqual([]);
  });

  it("renders an unrelated layout table but keeps an empty race table on direct HTTP", async () => {
    const browser = vi.fn(async (url: string) => ({ url, status: 200, html: fixture("dom-links") }));
    const route = `/timing/races?eventUrl=${encodeURIComponent(input.eventUrl)}`;
    const incomplete = setup('<table><tr><td>Site status</td></tr></table><main id="app"></main>', browser);
    expect((await incomplete.app.request(route)).status).toBe(200);
    expect(browser).toHaveBeenCalledTimes(1);
    browser.mockClear();
    const complete = setup('<table><tr><th>Race</th><th>Class</th></tr></table>', browser);
    expect(await (await complete.app.request(route)).json()).toEqual({ races: [] });
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects a redirected race and does not render after an HTTP failure", async () => {
    const browser = vi.fn();
    const app = createApp(new AnalysisWorkflow(new InMemoryAnalysisStore()), undefined, { store: new InMemoryTimingStore(), browser, fetch: async () => ({ url: input.raceUrl.replace("44", "45"), status: 200, html: fixture("dom-race") }) });
    expect((await app.request(`/timing/drivers?raceUrl=${encodeURIComponent(input.raceUrl)}`)).status).toBe(502);
    expect(browser).not.toHaveBeenCalled();
  });
});
