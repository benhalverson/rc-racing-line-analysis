## Destination

An implementation-ready MVP specification for a local-first teaching tool that imports one head-mounted GoPro race video, tracks a user-selected RC car, reconstructs its racing line relative to the track, aligns the result with LiveRC race timing, and lets the user compare it with drawn alternative lines.

## Notes

Domain: RC-car post-race coaching, computer vision, track-relative motion, and race timing.

Use `grilling` and `domain-modeling` for human decisions; use `research` for current computer-vision and LiveRC facts; use `prototype` where a concrete review workflow is needed. This is a new project. `rc-racer-flow` is reference material only and is not the implementation target.

Settled MVP assumptions: local web app; Angular frontend; Hono API; SQLite database; TypeScript/Node.js preferred, with Python/FastAPI only if required; offline batch processing; head-mounted GoPro input; one user-selected car per analysis; user-drawn bounding box; manual race-start point; automatic green-corner-marker detection with user correction; manual re-identification after tracking loss; track selected first, then event, class, and driver name; user-drawn alternative lines.

## Decisions so far

<!-- Closed decision tickets will be indexed here as the route advances. -->

- [Local CV Processing Boundary](issues/01-local-cv-processing-boundary.md) — The required production CV path is TypeScript/Node.js; Python/SAM 3 may only benchmark through an optional adapter.
- [LiveRC Timing Contract](issues/02-liverc-timing-contract.md) — A user-initiated HTML importer validates lap times and writes normalized timing records to SQLite; raw HTML is not retained.
- [GoPro Stabilization and Tracking Feasibility](issues/03-gopro-stabilization-tracking-feasibility.md) — A two-phase marker-review pipeline gates track-relative output; initial-box tracking exposes explicit confidence states and manual recovery.
- [Review and Comparison Semantics](issues/04-review-and-comparison-semantics.md) — Measured LiveRC/video evidence is separated from user-drawn hypothetical lines; alternatives receive geometry comparisons, not predicted times.
- [Local Analysis Data Model](issues/05-local-analysis-data-model.md) — Rerunnable analyses use reusable timing imports, versioned corrections, resumable runs, SQLite metadata, local artifacts, and named alternative lines.

## Not yet specified

No remaining decisions are currently specified for this destination.

## Out of scope

- Live or near-live processing.
- Cloud upload or hosted video analysis.
- Automatic car identity selection.
- Multi-car analysis in one review.
- Automatically generated fastest lines.
- Static NorCal Hobbies stream as an initial source profile; it may become a later profile with partial-track limitations.
- Multi-camera fusion, moving-camera footage beyond the head-mounted GoPro profile, and live race assistance.
