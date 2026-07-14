Type: research
Status: resolved

## Question

Determine the reliable LiveRC integration contract for a selected track, event, class, and driver name: available endpoints/pages, race and lap fields, ambiguity cases, access constraints, and a normalized timing shape suitable for local caching.

## Comments

## Answer

The MVP will use a user-initiated timing importer function. The user searches and selects a LiveRC track, selects an event, selects the exact heat or main event, then enters/selects the class and driver. The importer fetches the selected public page, parses its HTML, validates that individual lap times exist, and writes normalized timing records into SQLite.

The stored record includes track, event, race/heat/main, class, driver, result, and lap data plus lightweight provenance such as source URL, fetched time, selected display labels, and parser version. Raw HTML snapshots are not stored. A result without individual lap times is unsupported rather than silently treated as complete timing data.
