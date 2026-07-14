# Handoff: RC Racing Line Analysis MVP

## Purpose

Continue from a completed planning/wayfinding session and begin implementation of the new local-first RC-car race analysis app. No application code has been built for this project yet.

## Source of truth

The complete destination, decisions, domain vocabulary, ADRs, research, tickets, and prototype are under:

- `/home/ben/projects/.scratch/rc-racing-line-analysis/map.md`
- `/home/ben/projects/.scratch/rc-racing-line-analysis/CONTEXT.md`
- `/home/ben/projects/.scratch/rc-racing-line-analysis/docs/adr/`
- `/home/ben/projects/.scratch/rc-racing-line-analysis/issues/`
- `/home/ben/projects/.scratch/rc-racing-line-analysis/research/`
- `/home/ben/projects/.scratch/rc-racing-line-analysis/prototype/review-workflow.html`

All five wayfinding tickets are resolved. The map says the route to the implementation-ready MVP specification is complete.

## Agreed product direction

Build a local web app with Angular, Hono, SQLite, and a TypeScript/Node.js production CV path. It processes one head-mounted GoPro race video offline, lets the user select one car with a drawn box and optional description, detects/corrects green track markers, stabilizes the track view, tracks the car with explicit uncertainty and manual recovery, imports LiveRC lap timing into SQLite, and presents a review workspace with the observed line plus named user-drawn hypothetical alternatives.

Important boundaries:

- TypeScript/Node is the required production CV path; Python/SAM 3 may only be an optional benchmark/re-detection adapter.
- LiveRC is imported by a user-initiated HTML parsing function into normalized SQLite records; raw HTML is not stored.
- Alternative lines are geometry comparisons only. Do not predict lap times or call one faster.
- Large outputs live as local files referenced by SQLite; metadata, relationships, corrections, and lifecycle state live in SQLite.
- `rc-racer-flow` is reference material only, not the implementation target. Its current uncommitted changes must not be treated as this project’s code.

## Recommended next move

Create the new project structure and implement the thinnest vertical slice: local Angular/Hono shell, SQLite schema for tracks/events/timing imports/videos/analyses, and a batch-job state model. Keep the CV provider behind an interface so marker detection, stabilization, and tracking can be prototyped independently.

Use the review prototype as the initial UX reference, not production code. It is a static throwaway artifact and can be opened with `python3 -m http.server 8080` from its directory.

## Suggested skills

- `implement` — start the new project and build the agreed MVP slice.
- `tdd` — establish tests around the SQLite domain model, importer, and batch lifecycle.
- `codebase-design` — shape the CV provider and resumable processing seams.
- `frontend-design` — turn the validated review workflow into the Angular interface.
- `domain-modeling` — maintain `/home/ben/projects/.scratch/rc-racing-line-analysis/CONTEXT.md` as implementation vocabulary evolves.

## Cautions

Do not resume broad product grilling unless implementation exposes a genuinely new decision. Do not add cloud processing, live video, multi-car identity, automatic fastest-line generation, or the static NorCal Hobbies stream to this MVP without redrawing the destination.
