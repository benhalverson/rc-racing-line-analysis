import { fetchStructuredTimingPage, withinTimingTimeout } from "./timing-browser";
import { createHash, randomUUID } from "node:crypto";
import { load } from "cheerio/slim";
import { parse, type Node } from "acorn";
import type {
	TimingImport,
	TimingImportRequest,
	TimingImportSummary,
	TimingLap,
} from "../../shared/timing-contract";

export type {
	TimingImport,
	TimingImportRequest,
	TimingLap,
} from "../../shared/timing-contract";

export type TimingPage = { url: string; status: number; html: string };
export type TimingFetcher = (url: string) => Promise<TimingPage>;

export class TimingUpstreamError extends Error {
	readonly status = 502;
	constructor(status: number) { super(`LiveRC returned HTTP ${status}`); }
}

export class TimingGatewayError extends Error {
	readonly status = 502;
	constructor(message = "Unable to reach LiveRC", options?: ErrorOptions) {
		super(message, options);
	}
}

export class TimingParserError extends Error {
  readonly status = 502;
}

const timingRetryDelayMs = 25;

/** Fetch direct HTML with one transient retry and bounded upstream waits. */
export async function fetchTimingPage(fetcher: TimingFetcher, url: string) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let page: TimingPage;
		try {
			page = await withinTimingTimeout(() => fetcher(url));
		} catch (error) {
			if (attempt === 1) {
				throw new TimingGatewayError("Unable to reach LiveRC", error instanceof Error ? { cause: error } : undefined);
			}
			await new Promise((resolve) => setTimeout(resolve, timingRetryDelayMs));
			continue;
		}
		if (page.status >= 200 && page.status < 300) return page;
		if (page.status < 500 || page.status >= 600 || attempt === 1) throw new TimingUpstreamError(page.status);
		await new Promise((resolve) => setTimeout(resolve, timingRetryDelayMs));
	}
	throw new TimingGatewayError();
}
export type TimingStore = {
	saveTimingImport(value: TimingImport): Promise<void>;
	getTimingImport(id: string): Promise<TimingImport | undefined>;
	listTimingImports(limit: number): Promise<TimingImportSummary[]>;
};

export type { TimingImportSummary } from "../../shared/timing-contract";

export function normalizeTrackUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("trackUrl must be a valid LiveRC track URL");
	}
	if (
		!/^https?:$/.test(url.protocol) ||
		!url.hostname.endsWith(".liverc.com") ||
		url.hostname === "live.liverc.com" ||
		url.username ||
		url.password ||
		url.port
	) {
		throw new Error("trackUrl must be a valid LiveRC track URL");
	}
	return `${url.origin}/`;
}

export function normalizeLiveRcUrl(value: string, field = "url") {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`${field} must be a valid LiveRC URL`);
	}
	if (
		!/^https?:$/.test(url.protocol) ||
		!isLiveRcHost(url.hostname) ||
		url.username ||
		url.password ||
		url.port
	) {
		throw new Error(`${field} must be a valid LiveRC URL`);
	}
	return url;
}

export function normalizeRaceResultUrl(value: string) {
	const url = normalizeLiveRcUrl(value, "raceUrl");
	const id = url.searchParams.get("id")?.trim() ?? "";
	if (
		url.pathname !== "/results/" ||
		url.searchParams.get("p") !== "view_race_result" ||
		!/^[1-9]\d*$/.test(id)
	) {
		throw new Error("raceUrl must identify a LiveRC race result");
	}
	return url;
}

function isLiveRcHost(hostname: string) {
	return hostname.endsWith(".liverc.com") && hostname !== "live.liverc.com";
}

export class InMemoryTimingStore implements TimingStore {
	private readonly imports = new Map<string, TimingImport>();

	async saveTimingImport(value: TimingImport) {
		this.imports.set(value.id, value);
	}
	async getTimingImport(id: string) {
		return this.imports.get(id);
	}
	async listTimingImports(limit: number) {
		return [...this.imports.values()]
			.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
			.slice(0, limit)
			.map(toTimingImportSummary);
	}
}

export function toTimingImportSummary(
	value: TimingImport,
): TimingImportSummary {
	const {
		id,
		source,
		trackName,
		eventName,
		raceLabel,
		classLabel,
		driverName,
		driverId,
		fetchedAt,
		raceId,
	} = value;
	return {
		id,
		source,
		trackName,
		eventName,
		raceLabel,
		classLabel,
		driverName,
		driverId,
		fetchedAt,
		raceId,
	};
}

export function normalizeDriverName(value: string) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Collapse display whitespace after the DOM has decoded HTML entities. */
function text(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Read anchor attributes and nested display text without interpreting HTML as code. */
function links(html: string, baseUrl: string) {
  const $ = load(html);
  return $("a[href]").toArray().flatMap((anchor) => {
    try {
      return [{ url: new URL($(anchor).attr("href") ?? "", baseUrl).toString(), label: text($(anchor).text()) }];
    } catch { return []; }
  });
}

/** Parse same-source LiveRC links while preserving exact identifiers and display labels. */
export function parseTrackList(
	html: string,
	sourceUrl = "https://live.liverc.com/",
) {
	const source = new URL(sourceUrl);
	const tracks = links(html, sourceUrl)
		.filter((link) => {
			const url = new URL(link.url);
			return (
				url.hostname.endsWith(".liverc.com") && url.hostname !== source.hostname
			);
		})
		.flatMap((link) => {
			try {
				const url = normalizeTrackUrl(link.url);
				return [{ host: new URL(url).hostname, name: link.label, url }];
			} catch {
				return [];
			}
		});
	if (tracks.length === 0) throw new TimingParserError("LiveRC track list format changed");
	return tracks;
}

/** Parse same-source LiveRC links while preserving exact identifiers and display labels. */
export function parseEvents(html: string, sourceUrl: string) {
	const source = new URL(sourceUrl);
	const seen = new Set<string>();
	return links(html, sourceUrl).flatMap((link) => {
		const url = new URL(link.url);
		const eventId = url.searchParams.get("id")?.trim();
		const isEventResult =
			url.hostname === source.hostname &&
			url.pathname === "/results/" &&
			url.searchParams.get("p") === "view_event" &&
			!!eventId &&
			!["0", "null", "undefined"].includes(eventId.toLowerCase());
		if (!isEventResult || seen.has(eventId)) return [];
		seen.add(eventId);
		return [{ name: link.label, url: url.toString() }];
	});
}

export function classLabelFromRaceLabel(raceLabel: string) {
	const label = raceLabel.trim();
	const withoutRoundSuffix = label.replace(
		/\s*(?:\(\s*)?(?:(?:heat|round|qualifier)\s+\d+(?:\s*\/\s*\d+)?|[a-z]\d*(?:-?\s*)main|main)(?:\s*\))?$/i,
		"",
	).trim();
	return withoutRoundSuffix || label;
}

/** Parse same-source LiveRC links while preserving exact identifiers and display labels. */
export function parseRaces(html: string, sourceUrl: string) {
	const source = new URL(sourceUrl);
	const seen = new Set<string>();
	return links(html, sourceUrl).flatMap((link) => {
		const url = new URL(link.url);
		const id = url.searchParams.get("id")?.trim() ?? "";
		const valid =
			url.hostname === source.hostname &&
			url.pathname === "/results/" &&
			url.searchParams.get("p") === "view_race_result" &&
			/^[1-9]\d*$/.test(id);
		if (!valid || seen.has(id)) return [];
		seen.add(id);
		return [{ id, label: link.label, classLabel: classLabelFromRaceLabel(link.label), url: url.toString() }];
	});
}

/** Read result rows, keeping their display names and explicit result identifiers. */
function resultRows(html: string) {
  const $ = load(html);
  return $("tr").toArray().map((row) => {
    const cells = $(row).children("td, th").toArray().map((cell) => text($(cell).text()));
    const lapLink = $(row).find("a").toArray().find((anchor) => text($(anchor).text()) === "View Laps");
    let driverId = $(row).attr("data-driver-id") ?? $(row).find("[data-driver-id]").first().attr("data-driver-id");
    if (!driverId && lapLink) {
      const url = new URL($(lapLink).attr("href") ?? "", "https://track.liverc.com/results/");
      if (url.searchParams.get("p") === "view_driver_laps") driverId = url.searchParams.get("id") ?? undefined;
    }
    const name = lapLink ? text(cells.slice(1).join(" ")).match(/^\d+\s+(.+?)\s+View Laps\b/)?.[1] : undefined;
    return { cells, name, driverId };
  });
}

/** Discover drivers from DOM result rows, preserving duplicate names and IDs. */
export function parseDrivers(html: string) {
  return resultRows(html).flatMap(({ name, driverId }) => name ? [{ name, normalizedName: normalizeDriverName(name), ...(driverId ? { driverId } : {}) }] : []);
}

type SyntaxNode = Node & {
  expression?: SyntaxNode; left?: SyntaxNode; right?: SyntaxNode;
  object?: SyntaxNode; property?: SyntaxNode; name?: string; value?: unknown;
  computed?: boolean; operator?: string; properties?: SyntaxNode[];
  elements?: (SyntaxNode | null)[]; key?: SyntaxNode; kind?: string; method?: boolean;
};

/** Decode only literal data; reject calls, getters, spreads and executable expressions. */
function literal(node: SyntaxNode, depth = 0): unknown {
  if (depth > 32) throw new TimingParserError("LiveRC lap data is too deeply nested");
  if (node.type === "Literal" && (node.value === null || ["string", "number", "boolean"].includes(typeof node.value))) return node.value;
  if (node.type === "ArrayExpression") return node.elements?.map((item) => {
    if (!item) throw new TimingParserError("LiveRC lap data contains an array hole");
    return literal(item, depth + 1);
  });
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = Object.create(null);
    for (const property of node.properties ?? []) {
      if (property.type !== "Property" || property.computed || property.method || property.kind !== "init" || !property.key || !property.value) throw new TimingParserError("LiveRC lap data must contain literal properties");
      const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
      if (typeof key !== "string" || Object.hasOwn(value, key)) throw new TimingParserError("LiveRC lap data contains an invalid or duplicate key");
      value[key] = literal(property.value as SyntaxNode, depth + 1);
    }
    return value;
  }
  throw new TimingParserError("LiveRC lap data must be literal data");
}

/** Extract top-level racerLaps assignments using JavaScript syntax, never evaluation. */
export function embeddedRacers(html: string) {
  const $ = load(html);
  const racers: { id: string; driverName: string; laps: unknown[] }[] = [];
  for (const script of $("script").toArray()) {
    const source = $(script).text();
    if (!source.includes("racerLaps")) continue;
    let statements: SyntaxNode[];
    try { statements = parse(source, { ecmaVersion: "latest" }).body as SyntaxNode[]; }
    catch { throw new TimingParserError("LiveRC embedded lap data is malformed"); }
    for (const statement of statements) {
      const assignment = statement.expression;
      const target = assignment?.left;
      if (assignment?.type !== "AssignmentExpression" || target?.type !== "MemberExpression" || target.object?.name !== "racerLaps") continue;
      if (assignment.operator !== "=" || !target.computed || target.property?.type !== "Literal" || !assignment.right) throw new TimingParserError("LiveRC lap assignment is unsupported");
      const id = String(target.property.value);
      if (!/^[1-9]\d*$/.test(id) || racers.some((racer) => racer.id === id)) throw new TimingParserError("LiveRC lap result identity is invalid or duplicated");
      const value = literal(assignment.right) as { driverName?: unknown; laps?: unknown } | null;
      if (!value || typeof value.driverName !== "string" || !Array.isArray(value.laps)) throw new TimingParserError("LiveRC lap result format changed");
      racers.push({ id, driverName: value.driverName, laps: value.laps });
    }
  }
  return racers;
}

/** Normalize one embedded lap without relying on property order or quote style. */
function embeddedLap(value: unknown): TimingLap[] {
  if (!value || typeof value !== "object") throw new TimingParserError("LiveRC lap format changed");
  const lap = value as Record<string, unknown>;
  for (const key of ["lapNum", "time"]) {
    const field = lap[key];
    if (typeof field !== "number" && (typeof field !== "string" || !/^\d+(?:\.\d+)?$/.test(field))) throw new TimingParserError("LiveRC lap values must be decimal numbers");
  }
  const lapNumber = Number(lap.lapNum);
  const lapTimeSeconds = Number(lap.time);
  if (!Number.isInteger(lapNumber) || !Number.isFinite(lapTimeSeconds)) throw new TimingParserError("LiveRC lap values are invalid");
  if (lapNumber <= 0 || lapTimeSeconds <= 0) return [];
  return [{ lapNumber, lapTimeSeconds, lapTimeText: String(lap.time), valid: true, statusText: `${lap.pace ?? ""} · P${lap.pos ?? ""}` }];
}

/** Resolve a single selected result and its laps; never borrow another driver's laps. */
export function parseDriverResult(html: string, driverName: string, requestedDriverId?: string | null): { driverName: string; driverId: string | null; laps: TimingLap[] } {
  const wanted = normalizeDriverName(driverName);
  const rows = resultRows(html);
  const racers = embeddedRacers(html);
  const matching = racers.filter((racer) => normalizeDriverName(racer.driverName) === wanted);
  if (!requestedDriverId && matching.length > 1) throw new Error(`driver result is ambiguous for ${driverName}`);
  const racer = requestedDriverId ? racers.find((racer) => racer.id === requestedDriverId) : matching[0];
  if (racer && normalizeDriverName(racer.driverName) !== wanted) throw new Error(`driver result does not match ${driverName}`);
  if (!racer && racers.length) throw new Error(`driver result not found for ${driverName}`);
  const matchingRows = rows.filter((row) => row.name ? normalizeDriverName(row.name) === wanted : row.cells.some((cell) => normalizeDriverName(cell) === wanted));
  if (!requestedDriverId && matchingRows.length > 1) throw new Error(`driver result is ambiguous for ${driverName}`);
  const row = requestedDriverId ? matchingRows.find((row) => row.driverId === requestedDriverId) : matchingRows[0];
  if (!racer && requestedDriverId && rows.some((row) => row.driverId) && !row) throw new Error(`driver result not found for ${driverName}`);
  const $ = load(html);
  const heading = $("h1, h2, h3").toArray().map((element) => text($(element).text())).find((name) => normalizeDriverName(name) === wanted);
  const foundName = racer?.driverName ?? row?.name ?? matchingRows[0]?.cells.find((cell) => normalizeDriverName(cell) === wanted) ?? heading;
  if (!foundName) throw new Error(`driver result not found for ${driverName}`);
  let laps = racer ? racer.laps.flatMap(embeddedLap) : [];
  // An explicit embedded result with no laps is legitimate missing timing, not a rendering failure.
  if (!racer) {
    const drivers = parseDrivers(html);
    if (drivers.length > 1) throw new Error("selected driver result has no individual lap times");
    laps = rows.flatMap(({ cells }) => {
      if (cells.length < 3 || !/^\d+$/.test(cells[0]) || !/^\d+(?:\.\d+)?$/.test(cells[1]) || !/^\d+\/\d+:.+/.test(cells[2])) return [];
      return [{ lapNumber: Number(cells[0]), lapTimeSeconds: Number(cells[1]), lapTimeText: cells[1], valid: true, statusText: cells[3] ?? null }];
    });
    if (!laps.length) laps = $("div, p").toArray().flatMap((element) => {
      if ($(element).children().length) return [];
      const match = text($(element).text()).match(/^lap\s*(\d+)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:s|sec)?$/i);
      return match ? [{ lapNumber: Number(match[1]), lapTimeSeconds: Number(match[2]), lapTimeText: match[2], valid: true, statusText: null }] : [];
    });
  }
  if (!laps.length) throw new Error("selected driver result has no individual lap times");
  return { driverName: foundName, driverId: racer?.id ?? row?.driverId ?? null, laps };
}

/** Fetch and persist normalized timing plus lightweight provenance for offline review. */
export async function importTiming(
	input: TimingImportRequest,
	fetcher: TimingFetcher,
	store: TimingStore,
 browser?: TimingFetcher,
) {
	const raceUrl = normalizeRaceResultUrl(input.raceUrl);
	if (
		input.raceId &&
		/^[1-9]\d*$/.test(input.raceId) &&
		input.raceId !== raceUrl.searchParams.get("id")
	)
		throw new Error("selected race identity does not match raceUrl");
	const page = await fetchStructuredTimingPage(fetcher, raceUrl.toString(), "result", browser);
	if (
		page.url &&
		normalizeRaceResultUrl(page.url).toString() !== raceUrl.toString()
	)
		throw new Error("LiveRC returned a different race result URL");
	let result: ReturnType<typeof parseDriverResult>;
	try {
		result = parseDriverResult(page.html, input.driverName, input.driverId);
	} catch (error) {
		throw new TimingParserError(error instanceof Error ? error.message : "LiveRC race result format changed");
	}
	const value: TimingImport = {
		id: randomUUID(),
		source: "liverc",
		trackHost: input.trackHost,
		trackName: input.trackName,
		trackUrl: input.trackUrl,
		eventName: input.eventName,
		eventUrl: input.eventUrl,
		raceId: input.raceId ?? null,
		raceLabel: input.raceLabel,
		roundLabel: input.roundLabel,
		classLabel: input.classLabel,
		raceUrl: input.raceUrl,
		sourceHash: createHash("sha256").update(page.html).digest("hex"),
		driverName: result.driverName,
		normalizedDriverName: normalizeDriverName(result.driverName),
		driverId: result.driverId ?? input.driverId ?? null,
		laps: result.laps,
		fetchedAt: new Date().toISOString(),
		parserVersion: "liverc-dom-v2",
	};
	await store.saveTimingImport(value);
	return value;
}
