import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { TimingImport, TimingImportRequest, TimingLap } from "../../shared/timing-contract";
export type { TimingImport, TimingImportRequest, TimingLap } from "../../shared/timing-contract";

export type TimingPage = { url: string; status: number; html: string };
export type TimingFetcher = (url: string) => Promise<TimingPage>;

export type TimingStore = {
  saveTimingImport(value: TimingImport): Promise<void>;
  getTimingImport(id: string): Promise<TimingImport | undefined>;
};

export function normalizeTrackUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("trackUrl must be a valid LiveRC track URL");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.endsWith(".liverc.com") || url.hostname === "live.liverc.com" || url.username || url.password || url.port) {
    throw new Error("trackUrl must be a valid LiveRC track URL");
  }
  return `${url.origin}/`;
}

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
  }).map((link) => {
    const url = normalizeTrackUrl(link.url);
    return { host: new URL(url).hostname, name: link.label, url };
  });
}

export function parseEvents(html: string, sourceUrl: string) {
  const source = new URL(sourceUrl);
  const seen = new Set<string>();
  return links(html, sourceUrl).flatMap((link) => {
    const url = new URL(link.url);
    const eventId = url.searchParams.get("id")?.trim();
    const isEventResult = url.hostname === source.hostname && url.pathname === "/results/" && url.searchParams.get("p") === "view_event" && !!eventId && !["0", "null", "undefined"].includes(eventId.toLowerCase());
    if (!isEventResult || seen.has(eventId)) return [];
    seen.add(eventId);
    return [{ name: link.label, url: url.toString() }];
  });
}

export function parseRaces(html: string, sourceUrl: string) {
  return links(html, sourceUrl).filter((link) => /view_race_result|race_result|results\?/i.test(link.url)).map((link) => {
    const id = new URL(link.url).searchParams.get("id");
    return { id, label: link.label, url: link.url };
  });
}

export function parseDrivers(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const row = match[1];
    const plain = text(row);
    const name = plain.match(/\b\d+\s+\d+\s+(.+?)\s+View Laps\b/i)?.[1]?.trim();
    const driverId = row.match(/data-driver-id=["']([^"']+)["']/i)?.[1];
    if (!name) return [];
    return [{ name, normalizedName: normalizeDriverName(name), ...(driverId ? { driverId } : {}) }];
  });
}

export function parseDriverResult(html: string, driverName: string): { driverName: string; driverId: string | null; laps: TimingLap[] } {
  const wanted = normalizeDriverName(driverName);
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const pageText = normalizeDriverName(text(html));
  if (!pageText.includes(wanted)) throw new Error(`driver result not found for ${driverName}`);
  const driverRow = rows.find((candidate) => normalizeDriverName(text(candidate)).includes(wanted));
  const driverCells = driverRow ? [...driverRow.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => text(match[1])).filter(Boolean) : [];
  const foundName = driverCells.find((cell) => normalizeDriverName(cell) === wanted) ?? driverName;
  const racer = [...html.matchAll(/racerLaps\[(\d+)\]\s*=\s*\{([\s\S]*?)\};/gi)].map((match) => ({ id: match[1], body: match[2] })).find((candidate) => new RegExp(`'driverName'\\s*:\\s*'${escapeRegExp(foundName)}'`, "i").test(candidate.body));
  const embeddedLaps = racer ? [...racer.body.matchAll(/'lapNum'\s*:\s*'?(\d+)'?[\s\S]*?'pos'\s*:\s*'?(\d+)'?[\s\S]*?'time'\s*:\s*'?(\d+(?:\.\d+)?)'?\s*[\s\S]*?'pace'\s*:\s*'([^']*)'/gi)].filter((match) => Number(match[1]) > 0 && Number(match[3]) > 0).map((match) => ({ lapNumber: Number(match[1]), lapTimeSeconds: Number(match[3]), lapTimeText: match[3], valid: true, statusText: `${match[4]} · ${match[2]}th` })) : [];
  const tableLaps = rows.flatMap((row) => {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => text(match[1])).filter(Boolean);
    if (cells.length < 3 || !/^\d+$/.test(cells[0]) || !/^\d+(?:\.\d+)?$/.test(cells[1]) || !/^\d+\/\d+:.+/.test(cells[2])) return [];
    return [{ lapNumber: Number(cells[0]), lapTimeSeconds: Number(cells[1]), lapTimeText: cells[1], valid: true, statusText: cells[3] ?? null }];
  });
  const explicitLaps = [...html.matchAll(/\blap\s*(\d+)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:s|sec)?\b/gi)].map((match) => ({
    lapNumber: Number(match[1]), lapTimeSeconds: Number(match[2]), lapTimeText: match[2], valid: true, statusText: null,
  }));
  const laps = embeddedLaps.length > 0 ? embeddedLaps : tableLaps.length > 0 ? tableLaps : explicitLaps;
  if (laps.length === 0) throw new Error("selected driver result has no individual lap times");
  return { driverName: foundName, driverId: racer?.id ?? null, laps };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function importTiming(input: TimingImportRequest, fetcher: TimingFetcher, store: TimingStore) {
  const page = await fetcher(input.raceUrl);
  if (page.status < 200 || page.status >= 300) throw new Error(`LiveRC returned HTTP ${page.status}`);
  const result = parseDriverResult(page.html, input.driverName);
  const value: TimingImport = {
    id: randomUUID(), source: "liverc", trackHost: input.trackHost, trackName: input.trackName, trackUrl: input.trackUrl,
    eventName: input.eventName, eventUrl: input.eventUrl, raceId: input.raceId ?? null, raceLabel: input.raceLabel,
    roundLabel: input.roundLabel, classLabel: input.classLabel, raceUrl: input.raceUrl,
    sourceHash: createHash("sha256").update(page.html).digest("hex"), driverName: result.driverName,
    normalizedDriverName: normalizeDriverName(result.driverName), driverId: result.driverId ?? input.driverId ?? null, laps: result.laps,
    fetchedAt: new Date().toISOString(), parserVersion: "liverc-html-v1",
  };
  await store.saveTimingImport(value);
  return value;
}
