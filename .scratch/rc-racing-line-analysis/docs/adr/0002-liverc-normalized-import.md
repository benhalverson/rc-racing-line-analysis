# ADR-0002: Import LiveRC Pages into Normalized SQLite Records

## Status

Accepted

## Context

The user selects a LiveRC track, event, heat or main event, class, and driver. The application needs the race's individual lap times for video alignment. LiveRC presents this information through public web pages, but the application should own a stable local representation for analysis and offline review.

## Decision

Implement a user-initiated importer function that fetches the selected LiveRC page, parses its HTML, validates that individual lap times are present, and writes normalized track, event, race, driver, result, and lap records into SQLite.

The importer will store lightweight provenance—source URL, fetched time, selected display labels, and parser version—but will not store raw HTML snapshots. A result without individual lap times is unsupported for this workflow and must not be silently imported as a complete timing record.

The UI flow is: search and select a LiveRC track; search and select an event; select a heat or main event; enter/select class and driver; confirm the exact matching result; import and cache the normalized timing data.

## Consequences

- Existing analyses can be reviewed offline from SQLite.
- Parser changes cannot reprocess old raw pages locally because HTML is not retained.
- Source URLs and parser versions provide enough provenance to identify the import path and support an explicit refresh.
- The importer must handle duplicate names and repeated classes by requiring exact heat/main selection.
