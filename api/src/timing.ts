import { createHash, randomUUID } from "node:crypto";
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

export async function fetchTimingPage(fetcher: TimingFetcher, url: string) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let page: TimingPage;
		try {
			page = await fetcher(url);
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

function text(value: string) {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

function links(html: string, baseUrl: string) {
	return [
		...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
	].flatMap((match) => {
		try {
			return [{ url: new URL(match[1], baseUrl).toString(), label: text(match[2]) }];
		} catch {
			return [];
		}
	});
}

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
		return [{ id, label: link.label, url: url.toString() }];
	});
}

export function parseDrivers(html: string) {
	return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(
		(match) => {
			const row = match[1];
			const plain = text(row);
			const name = plain
				.match(/\b\d+\s+\d+\s+(.+?)\s+View Laps\b/i)?.[1]
				?.trim();
			const driverId =
				row.match(/data-driver-id=["']([^"']+)["']/i)?.[1] ??
				row.match(
					/href=["'][^"']*p=view_driver_laps[^"']*[?&]id=([1-9]\d*)/i,
				)?.[1];
			if (!name) return [];
			return [
				{
					name,
					normalizedName: normalizeDriverName(name),
					...(driverId ? { driverId } : {}),
				},
			];
		},
	);
}

export function parseDriverResult(
	html: string,
	driverName: string,
	requestedDriverId?: string | null,
): { driverName: string; driverId: string | null; laps: TimingLap[] } {
	const wanted = normalizeDriverName(driverName);
	const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
		(match) => match[1],
	);
	const pageText = normalizeDriverName(text(html));
	if (!pageText.includes(wanted))
		throw new Error(`driver result not found for ${driverName}`);
	const driverRow = requestedDriverId
		? rows.find(
				(candidate) =>
					candidate.match(/data-driver-id=["']([^"']+)["']/i)?.[1] ===
						requestedDriverId ||
					candidate.match(
						/href=["'][^"']*p=view_driver_laps[^"']*[?&]id=([1-9]\d*)/i,
					)?.[1] === requestedDriverId,
			)
		: rows.find((candidate) =>
				normalizeDriverName(text(candidate)).includes(wanted),
			);
	const driverCells = driverRow
		? [...driverRow.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
				.map((match) => text(match[1]))
				.filter(Boolean)
		: [];
	const racers = [
		...html.matchAll(/racerLaps\[(\d+)\]\s*=\s*\{([\s\S]*?)\};/gi),
	].map((match) => ({ id: match[1], body: match[2] }));
	const matchingRacers = racers.filter((candidate) =>
		new RegExp(
			`["']driverName["']\\s*:\\s*["']${escapeRegExp(driverName)}["']`,
			"i",
		).test(candidate.body),
	);
	const racer = requestedDriverId
		? racers.find((candidate) => candidate.id === requestedDriverId)
		: matchingRacers.length === 1
			? matchingRacers[0]
			: undefined;
	if (
		requestedDriverId &&
		!racer &&
		(rows.some((row) => /data-driver-id=["']|p=view_driver_laps/i.test(row)) ||
			racers.length > 0)
	)
		throw new Error(`driver result not found for ${driverName}`);
	if (
		!requestedDriverId &&
		racer === undefined &&
		racers.filter((candidate) =>
			normalizeDriverName(candidate.body).includes(wanted),
		).length > 1
	)
		throw new Error(`driver result is ambiguous for ${driverName}`);
	const foundName = racer
		? (racer.body.match(/["']driverName["']\s*:\s*["']([^'"]+)/i)?.[1] ??
			driverCells.find((cell) => normalizeDriverName(cell) === wanted) ??
			driverName)
		: (driverCells.find((cell) => normalizeDriverName(cell) === wanted) ??
			driverName);
	if (normalizeDriverName(foundName) !== wanted)
		throw new Error(`driver result does not match ${driverName}`);
	const embeddedLaps = racer
		? [
				...racer.body.matchAll(
					/'lapNum'\s*:\s*'?(\d+)'?[\s\S]*?'pos'\s*:\s*'?(\d+)'?[\s\S]*?'time'\s*:\s*'?(\d+(?:\.\d+)?)'?\s*[\s\S]*?'pace'\s*:\s*'([^']*)'/gi,
				),
			]
				.filter((match) => Number(match[1]) > 0 && Number(match[3]) > 0)
				.map((match) => ({
					lapNumber: Number(match[1]),
					lapTimeSeconds: Number(match[3]),
					lapTimeText: match[3],
					valid: true,
					statusText: `${match[4]} · P${match[2]}`,
				}))
		: [];
	const tableLaps = rows.flatMap((row) => {
		const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
			.map((match) => text(match[1]))
			.filter(Boolean);
		if (
			cells.length < 3 ||
			!/^\d+$/.test(cells[0]) ||
			!/^\d+(?:\.\d+)?$/.test(cells[1]) ||
			!/^\d+\/\d+:.+/.test(cells[2])
		)
			return [];
		return [
			{
				lapNumber: Number(cells[0]),
				lapTimeSeconds: Number(cells[1]),
				lapTimeText: cells[1],
				valid: true,
				statusText: cells[3] ?? null,
			},
		];
	});
	const explicitLaps = [
		...html.matchAll(
			/\blap\s*(\d+)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*(?:s|sec)?\b/gi,
		),
	].map((match) => ({
		lapNumber: Number(match[1]),
		lapTimeSeconds: Number(match[2]),
		lapTimeText: match[2],
		valid: true,
		statusText: null,
	}));
	const laps =
		embeddedLaps.length > 0
			? embeddedLaps
			: tableLaps.length > 0
				? tableLaps
				: explicitLaps;
	if (laps.length === 0)
		throw new Error("selected driver result has no individual lap times");
	return { driverName: foundName, driverId: racer?.id ?? null, laps };
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function importTiming(
	input: TimingImportRequest,
	fetcher: TimingFetcher,
	store: TimingStore,
) {
	const raceUrl = normalizeRaceResultUrl(input.raceUrl);
	if (
		input.raceId &&
		/^[1-9]\d*$/.test(input.raceId) &&
		input.raceId !== raceUrl.searchParams.get("id")
	)
		throw new Error("selected race identity does not match raceUrl");
	const page = await fetchTimingPage(fetcher, raceUrl.toString());
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
		parserVersion: "liverc-html-v1",
	};
	await store.saveTimingImport(value);
	return value;
}
