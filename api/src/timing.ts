import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

export type TimingLap = {
  lapNumber: number;
  lapTimeSeconds: number | null;
  lapTimeText: string;
  valid: boolean | null;
  statusText: string | null;
};

export type TimingImport = {
  id: string;
  source: "liverc";
  trackHost: string;
  trackName: string;
  trackUrl: string;
  eventName: string;
  eventUrl: string;
  raceId: string | null;
  raceLabel: string;
  roundLabel: string;
  classLabel: string;
  raceUrl: string;
  driverName: string;
  normalizedDriverName: string;
  driverId: string | null;
  fetchedAt: string;
  parserVersion: string;
  sourceHash: string;
  laps: TimingLap[];
};

export type TimingPage = { url: string; status: number; html: string };
export type TimingFetcher = (url: string) => Promise<TimingPage>;

export type TimingStore = {
  saveTimingImport(value: TimingImport): Promise<void>;
  getTimingImport(id: string): Promise<TimingImport | undefined>;
};

export class InMemoryTimingStore implements TimingStore {
  private readonly imports = new Map<string, TimingImport>();

  async saveTimingImport(value: TimingImport) { this.imports.set(value.id, value); }
  async getTimingImport(id: string) { return this.imports.get(id); }
}

export function normalizeDriverName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function text(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function links(html: string, baseUrl: string) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    url: new URL(match[1], baseUrl).toString(),
    label: text(match[2]),
  }));
}

export function parseTrackList(html: string, sourceUrl = "https://live.liverc.com/") {
  const source = new URL(sourceUrl);
  return links(html, sourceUrl).filter((link) => {
    const url = new URL(link.url);
    return url.hostname.endsWith(".liverc.com") && url.hostname !== source.hostname;
  }).map((link) => ({ host: new URL(link.url).hostname, name: link.label, url: link.url }));
}

export function parseEvents(html: string, sourceUrl: string) {
  return links(html, sourceUrl).filter((link) => /event|results/i.test(link.url + link.label)).map((link) => ({ name: link.label, url: link.url }));
}

export function parseRaces(html: string, sourceUrl: string) {
  return links(html, sourceUrl).filter((link) => /view_race_result|race_result|results\?/i.test(link.url)).map((link) => {
    const id = new URL(link.url).searchParams.get("id");
    return { id, label: link.label, url: link.url };
  });
}

export function parseDrivers(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => text(cell[1])).filter(Boolean);
    const name = cells.find((cell) => /[a-z]/i.test(cell) && !/^(driver|name|class)$/i.test(cell));
    return name ? [{ name, normalizedName: normalizeDriverName(name) }] : [];
  });
}

export function parseDriverResult(html: string, driverName: string): { driverName: string; driverId: string | null; laps: TimingLap[] } {
  const wanted = normalizeDriverName(driverName);
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const row = rows.find((candidate) => normalizeDriverName(text(candidate)).includes(wanted));
  if (!row) throw new Error(`driver result not found for ${driverName}`);
  const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => text(match[1])).filter(Boolean);
  const foundName = cells.find((cell) => normalizeDriverName(cell) === wanted) ?? driverName;
  const laps = [...html.matchAll(/(?:lap|#)\s*(\d+)\D+(\d+(?:\.\d+)?)\s*(?:s|sec)?/gi)].map((match) => ({
    lapNumber: Number(match[1]), lapTimeSeconds: Number(match[2]), lapTimeText: match[2], valid: true, statusText: null,
  }));
  if (laps.length === 0) throw new Error("selected driver result has no individual lap times");
  return { driverName: foundName, driverId: null, laps };
}

export async function importTiming(input: Omit<TimingImport, "id" | "source" | "fetchedAt" | "parserVersion" | "sourceHash" | "driverName" | "normalizedDriverName" | "driverId" | "laps"> & { driverName: string }, fetcher: TimingFetcher, store: TimingStore) {
  const page = await fetcher(input.raceUrl);
  if (page.status < 200 || page.status >= 300) throw new Error(`LiveRC returned HTTP ${page.status}`);
  const result = parseDriverResult(page.html, input.driverName);
  const value: TimingImport = {
    ...input, id: randomUUID(), source: "liverc", fetchedAt: new Date().toISOString(), parserVersion: "liverc-html-v1",
    sourceHash: createHash("sha256").update(page.html).digest("hex"), driverName: result.driverName,
    normalizedDriverName: normalizeDriverName(result.driverName), driverId: result.driverId, laps: result.laps,
  };
  await store.saveTimingImport(value);
  return value;
}
