import { load } from "cheerio/slim";
import { embeddedRacers, fetchTimingPage, normalizeLiveRcUrl, parseDrivers, parseEvents, parseRaces, parseTrackList, TimingGatewayError, TimingParserError, type TimingFetcher, type TimingPage } from "./timing";

export type TimingPageKind = "tracks" | "events" | "races" | "drivers" | "result";

/** Optional Browser Run binding; no token or browser is required for direct HTTP. */
export interface TimingBrowserBinding {
  quickAction(action: "content", options: { url: string; gotoOptions: { waitUntil: "networkidle0"; timeout: number } }): Promise<Response>;
}

/** Bound the entire upstream operation, including response body consumption. */
export async function withinTimingTimeout<T>(action: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimingGatewayError("Timing upstream timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Identify a rendered list/result or an explicit empty state, independently of selection. */
function hasStructure(page: TimingPage, kind: TimingPageKind) {
  const $ = load(page.html);
  // Recognized timing headers retain completion even when the table has no data rows.
  const headerPatterns: Record<TimingPageKind, RegExp> = {
    tracks: /\b(track|venue|hobby shop)\b/i,
    events: /\b(event|date)\b/i,
    races: /\b(race|heat|main|round|class)\b/i,
    drivers: /\b(driver|racer|car|position|pos)\b/i,
    result: /\b(driver|racer|lap|time|pace)\b/i,
  };
  if ($("table th").toArray().some((cell) => headerPatterns[kind].test($(cell).text()))) return true;
  const visible = $.root().clone();
  visible.find("script, style, template").remove();
  if (/\bno\s+(?:(?:archived|race|matching|available)\s+)?(?:events|races|results|drivers|tracks|laps)\b|\b(?:events|races|results|drivers|tracks|laps)\s+(?:not found|unavailable)\b/i.test(visible.text())) return true;
  if (kind === "events") return parseEvents(page.html, page.url).length > 0;
  if (kind === "races") return parseRaces(page.html, page.url).length > 0;
  if (kind === "tracks") {
    try { return parseTrackList(page.html, page.url).length > 0; }
    catch (error) { if (error instanceof TimingParserError) return false; throw error; }
  }
  if (parseDrivers(page.html).length > 0) return true;
  return embeddedRacers(page.html).length > 0;
}

/** Prefer direct HTML; render once only if the requested page has no result structure. */
export async function fetchStructuredTimingPage(fetcher: TimingFetcher, url: string, kind: TimingPageKind, browser?: TimingFetcher) {
  const direct = await fetchTimingPage(fetcher, url);
  if (new URL(direct.url).toString() !== new URL(url).toString()) throw new TimingGatewayError("LiveRC returned a different timing URL");
  if (hasStructure(direct, kind) || !browser) return direct;
  let rendered: TimingPage;
  try { rendered = await withinTimingTimeout(() => browser(url)); }
  catch (error) {
    if (error instanceof TimingGatewayError) throw error;
    throw new TimingGatewayError("Unable to render LiveRC timing", error instanceof Error ? { cause: error } : undefined);
  }
  if (rendered.status < 200 || rendered.status >= 300) throw new TimingGatewayError(`Browser Run returned HTTP ${rendered.status}`);
  if (rendered.url !== url) throw new TimingGatewayError("Browser Run returned a different timing URL");
  if (!hasStructure(rendered, kind)) throw new TimingParserError("LiveRC timing page is structurally incomplete");
  return rendered;
}

/** Adapt Browser Run /content through the optional Workers quickAction binding. */
export function browserTimingFetcher(binding?: TimingBrowserBinding): TimingFetcher | undefined {
  if (!binding) return undefined;
  return async (url) => {
    if (url !== "https://live.liverc.com/") normalizeLiveRcUrl(url);
    return withinTimingTimeout(async () => {
      const response = await binding.quickAction("content", { url, gotoOptions: { waitUntil: "networkidle0", timeout: 10_000 } });
      if (!response.ok) throw new TimingGatewayError(`Browser Run returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      let html: string;
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { success?: boolean; result?: unknown };
        if (payload.success !== true || typeof payload.result !== "string") throw new TimingGatewayError("Browser Run returned invalid content");
        html = payload.result;
      } else {
        html = await response.text();
      }
      return { url, status: response.status, html };
    });
  };
}
