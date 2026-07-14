# ADR-0005: Use Rerunnable Local Analysis Records

## Status

Accepted

## Context

The app performs expensive offline processing and requires operator corrections. Marker and tracking corrections may change without changing the source video or imported race timing. Large outputs should not make SQLite unwieldy, and timing data should be reusable across analyses.

## Decision

The MVP uses these durable concepts:

- **Track** — selected LiveRC track identity and host.
- **Event** — selected event belonging to a track.
- **Timing import** — reusable normalized LiveRC data, including the selected heat/main, class, driver, result, and laps.
- **Video input** — local GoPro file metadata and path/reference.
- **Analysis** — one video, one selected car, one timing record, and the accepted correction/configuration versions.
- **Correction set** — versioned marker-map, start/finish, car-selection, crossing, and re-identification corrections.
- **Processing run** — a resumable execution of an analysis with phase, progress, checkpoint, provider/version, and error state.
- **Artifact** — a local file such as frame observations, transforms, line data, overlays, or annotated video referenced from SQLite.
- **Alternative line** — a named, versioned user-drawn hypothetical path attached to an analysis.

SQLite stores metadata, relationships, states, correction history, and artifact references. Large frame/video outputs remain local files. Processing runs expose explicit states including `draft`, `awaiting_calibration`, `ready`, `queued`, `running`, `needs_correction`, `completed`, `failed`, and `cancelled`.

Corrections are append-only and reruns select an accepted correction-set version. Timing imports are reusable across analyses. Alternative lines are multiple, named, and versioned.

## Consequences

- A user can correct and rerun an analysis without re-importing its video or timing.
- Failed jobs can resume from checkpoints or explain their last successful phase.
- SQLite remains a manageable index rather than a video/blob store.
- Historical correction and alternative-line decisions remain reproducible.
