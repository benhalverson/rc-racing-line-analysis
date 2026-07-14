# LiveRC timing contract research

**Research date:** 2026-07-13
**Question:** Determine the reliable LiveRC integration contract for a selected track, event, class, and driver name, including race/lap fields, ambiguity cases, access constraints, and a normalized local-cache shape.

## Executive conclusion

LiveRC is a public, track-scoped web presentation of data produced by the LiveTime Scoring Engine. The stable integration boundary visible from first-party pages is a set of HTML pages, not a documented public API:

1. Select a track from `live.liverc.com`; each track has a stable-looking subdomain such as `rcra.liverc.com`.
2. Use the track's results page to select an event. The page exposes event title/date, event-level counts, rounds, classes/races, completion timestamps, and links to result views.
3. Select a specific race result, then a driver, to obtain driver-level lap information. LiveRC's own product description says that selecting a driver exposes lap times and detailed performance data.
4. Cache the retrieved source page and normalize only fields actually present. Keep source URLs and raw labels because names, classes, race labels, and result rules are not canonical enough to reconstruct safely from display text.

There is no first-party public API specification discovered for these pages. The MVP should therefore treat LiveRC as a best-effort HTML import adapter with a manual review path, rather than promise a durable API contract.

## First-party page surfaces

### Track discovery and selection

The public track list is [live.liverc.com](https://live.liverc.com/). It lists tracks with status, track display name, and the track-specific hostname. The page distinguishes live video, featured event, racing in progress, open practicing, and no track activity. A track link is the natural first selection key; for example, the RCRA track links to `rcra.liverc.com`.

LiveRC's own explanation of the broadcast page says that the track list includes currently running tracks, identifies video availability, supports searching offline tracks, and takes the user to a track dashboard with a special track URL. See [LiveRC's broadcast-page announcement](https://www.liverc.com/news/lrc-weve-launched-our-new-broadcast-page/) (especially the track-list and dashboard sections).

**Contract recommendation:** store both `trackHost` (for example, `rcra.liverc.com`) and the observed `trackName`. Do not derive a host by slugifying the display name. Hosts are arbitrary and may not equal the venue name.

### Event selection and archive

The track results page is conventionally:

```text
https://{trackHost}/results/
```

An observed public example is [RCRA 2026 Nationals results](https://rcra.liverc.com/results/). It contains:

- track name and event title;
- event start/end dates;
- an entry-list link;
- round groups such as Practice, Qualifier, and Main Events;
- race links with race number, class/race label, and time completed;
- overall/ranking views such as Final Results and qualifier rankings;
- event statistics including entries, drivers, and total race laps.

The track's archived-event page is conventionally:

```text
https://{trackHost}/events/
```

See [RCRA archived events](https://rcra.liverc.com/events/). It lists event name, date range, entry count, and driver count, and lets the user choose an older event before loading its results page. LiveRC's first-party announcement explicitly documents choosing a track and date to revisit archived race results.

**Contract recommendation:** an event is identified by the track host plus the event-specific URL/query or source identifier, not by event name/date alone. Event names and dates are display labels and can collide.

### Class and race selection

The results page groups races by round type and presents class/race labels such as `Buggy (Heat 2/7)`, `EP Buggy A1-Main`, or `Modified Touring A-Main`. The same class can occur in multiple rounds and multiple heats/mains. A class label is therefore not sufficient to identify a timed run.

An observed result link uses the query pattern:

```text
https://{trackHost}/results/?p=view_race_result&id={raceResultId}
```

For example, the public RCRA index links its `Race 44: Buggy 1/1 Final` to `https://rcra.liverc.com/results/?id=6582282&p=view_race_result`. The ordering of query parameters should not be treated as significant; the important values are the view name and race-result identifier.

**Contract recommendation:** store `roundName`, `raceNumber`, `raceLabel`, `classLabel`, and the opaque `raceResultId`/source URL. Make the race-result identifier the primary local identity when available. Do not infer `A-Main` versus `Heat` from a class name alone.

### Driver selection

LiveRC's first-party description says that selecting a particular driver in current event results opens that driver's lap times and detailed performance data. The same description says that practice-driver views expose class, transponder number, session date/time, lap times, and averages. See [LiveRC broadcast-page announcement](https://www.liverc.com/news/lrc-weve-launched-our-new-broadcast-page/) and the public practice-session examples indexed by LiveRC, such as [this LiveRC practice session](https://enhobbies.liverc.com/practice/?id=23534567&p=view_session).

Driver names are not a safe global identity key. LiveTime's own release notes describe searching by name, nickname, and transponder number, while event imports require first and last name and class name. The same person can appear with spelling, nickname, accent, or capitalization differences; two people can share a name; and a driver can have different entries/transponders across races.

**Contract recommendation:** driver matching should be scoped to one event/race and should prefer an exact visible driver row or stable driver/transponder identifier when exposed. A name-only match must yield zero, one, or many candidates; never silently select the first fuzzy match. Preserve the displayed name exactly and store a normalized comparison form separately.

## Timing fields and semantics

The public results index reliably exposes race-level metadata:

- `raceNumber` — displayed race sequence number;
- `roundType` — for example Practice, Qualifier Round 1, or Main Events;
- `raceLabel`/class label — the display name for the class and heat/main;
- `completedAt` — displayed local date/time labelled “Time Completed”;
- event/track context — event title, date range, track name;
- aggregate event counts — entries, drivers, total race laps.

The driver result view is the source for driver-level timing. Depending on the race/session and what the host published, expect some combination of:

- driver display name and possibly car number/transponder;
- class/race and result position;
- completed laps or lap count;
- total race time;
- best lap and latest/individual lap times;
- per-lap sequence number and lap duration;
- validity/status information (for example invalid laps, DNS/DNF, or adjusted results);
- optional sector/segment values where the timing setup and published report include them.

The exact field set is configuration- and view-dependent. LiveTime's first-party download notes document adjustable minimum-lap validation, result recalculation, driver/transponder correction, segment support, sector names, and race-result exports. Its feature page documents recent laps, missed-lap correction, best-lap display, and detailed reports. These are reasons to preserve validity/status and source text rather than assume every lap is a clean, immutable sensor observation.

LiveRC also publishes some result reports as downloadable event files/PDFs for major events. Those are useful fallbacks when a page does not expose the needed detail, but they are report artifacts rather than a uniform API. Example first-party-hosted artifacts indexed by LiveRC include [individual lap times](https://s3.amazonaws.com/assets.liveracemedia.com/event_files/7478/503469/Race_Individual_Lap_Times_6736097.pdf) and [detailed lap times](https://s3.amazonaws.com/assets.liveracemedia.com/event_files/7478/501982/Race_Detailed_Lap_Times_6699949.pdf).

## Proposed normalized cache shape

This is a local application shape, not a claim that LiveRC returns JSON with these names:

```ts
type TimingImport = {
  source: "liverc";
  fetchedAt: string;                 // ISO instant
  track: {
    host: string;
    displayName: string;
    sourceUrl: string;
  };
  event: {
    sourceId?: string;               // opaque id if present
    displayName: string;
    startDate?: string;              // source-local calendar date
    endDate?: string;
    sourceUrl: string;
  };
  race: {
    sourceId?: string;               // race-result id when present
    raceNumber?: number;
    roundLabel: string;
    classLabel: string;
    raceLabel: string;
    completedAtText?: string;
    completedAt?: string;            // resolved only with known source timezone
    sourceUrl: string;
  };
  driver: {
    sourceId?: string;
    displayName: string;
    normalizedName: string;
    transponderText?: string;
    carNumberText?: string;
    matchStatus: "unmatched" | "unique" | "ambiguous" | "confirmed";
  };
  result?: {
    position?: number;
    lapsCompleted?: number;
    totalTimeSeconds?: number;
    bestLapSeconds?: number;
    statusText?: string;
  };
  laps: Array<{
    lapNumber: number;
    lapTimeSeconds?: number;
    lapTimeText?: string;
    valid?: boolean;
    statusText?: string;
    sourceRow?: string;
  }>;
  raw: {
    fetchedPages: Array<{ url: string; sha256: string; fetchedAt: string }>;
    parserVersion: string;
  };
};
```

Important choices:

- Keep source-local text alongside parsed numbers; this prevents loss of `DNF`, invalid-lap markers, and unusual time formats.
- Keep `completedAtText` unless the track timezone is known. A displayed time without timezone is not safe to convert to an instant.
- Treat a race result as a separate object from the class. The same class has multiple heats/rounds.
- Keep every lap in sequence, including invalid or missing-status rows, so downstream video alignment can explain gaps.
- Store the raw source snapshot/hash and parser version so a later parser change can reproduce or invalidate an import.

## Ambiguity and failure cases

1. **Track-name collision or changed host.** Use the selected track link/host, not a name-derived URL.
2. **Multiple events on one track.** Match the archived event by source page/id and date range; do not choose by title only.
3. **Repeated class labels.** A class may have practice, several qualifying rounds, heats, bump-ups, and multiple mains.
4. **Combined or ladder mains.** Display labels can include odd/even, A/B/C, practice, or ladder wording. Preserve the complete label and race id.
5. **Duplicate driver names.** Require event/race scope and user confirmation when more than one row matches.
6. **Name normalization.** Accents, punctuation, nickname, ordering, and capitalization can change the rendered name. Fuzzy matching is candidate generation only.
7. **Missing or adjusted laps.** Timing software supports minimum-lap validation, missed-lap correction, and post-race adjustment; a lap record can be invalid, absent, or recalculated.
8. **Different published views.** Results, practice, rankings, downloadable reports, and live pages do not expose the same fields. The importer must declare which view produced each record.
9. **Timezone ambiguity.** Results show local-looking timestamps; source pages do not provide a universal timezone contract in the page text inspected.
10. **No result published.** A track can be listed but have no archived event, no completed race, or only a partial report. This is a normal “not available” outcome.

## Access constraints and implementation boundary

- The pages inspected are publicly viewable without a LiveRC account. LiveRC also exposes account registration/login and some product functionality is for track operators.
- LiveTime's official download page says an internet connection is not required for the scoring engine itself, but is required for live result/broadcasting features. This implies that a track can have local timing data that is not yet published or is unavailable online.
- I found no first-party public API documentation, schema, rate limit, authentication contract, or permission contract for programmatic retrieval of the public result pages. Do not build the MVP around guessed JSON endpoints or undocumented internal AJAX calls.
- A normal HTTP client may receive different behavior from a browser-rendered page (redirects, anti-bot/proxy errors, cache misses, or incomplete dynamic content). The importer should record HTTP status, final URL, content type, and a human-readable failure reason.
- Respect LiveRC/LiveRaceMedia terms, robots/access policies, reasonable request rates, and event-host permissions before operating an automated importer at scale. Start with user-initiated, low-volume imports and cache successful pages.

## MVP recommendation

Implement the UX as a guided, user-confirmed import:

1. User selects or pastes a track URL/host.
2. Importer lists the event archive and results page.
3. User selects an event, then a specific round/race, then a driver row.
4. Importer stores the source HTML/report and normalized timing, showing the exact selected labels and any ambiguous/missing fields.
5. User confirms the driver before video alignment.

For the first vertical slice, support the public results HTML pages and one manually selected race. Add PDF/report parsing only when the target track/event does not expose the required individual lap view. Treat direct API integration as a separate discovery task requiring cooperation/documentation from LiveTime or the track operator.

## Sources

- [LiveRC public track list](https://live.liverc.com/)
- [RCRA public event results example](https://rcra.liverc.com/results/)
- [RCRA archived event list](https://rcra.liverc.com/events/)
- [LiveRC: “We've launched our new broadcast page!”](https://www.liverc.com/news/lrc-weve-launched-our-new-broadcast-page/)
- [LiveTime Scoring Engine home](https://www.livetimescoring.com/)
- [LiveTime download page and release notes](https://www.livetimescoring.com/download/)
- [LiveTime features and pricing](https://www.livetimescoring.com/features/)
- [Public LiveRC practice-session example](https://enhobbies.liverc.com/practice/?id=23534567&p=view_session)
- [LiveRC-hosted individual-lap report example](https://s3.amazonaws.com/assets.liveracemedia.com/event_files/7478/503469/Race_Individual_Lap_Times_6736097.pdf)
- [LiveRC-hosted detailed-lap report example](https://s3.amazonaws.com/assets.liveracemedia.com/event_files/7478/501982/Race_Detailed_Lap_Times_6699949.pdf)
