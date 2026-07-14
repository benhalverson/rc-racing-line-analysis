Type: grilling
Status: resolved
Blocked by: 01, 02, 03

## Question

Define the local webapp’s durable domain model and processing lifecycle: tracks, events, race timing imports, videos, analyses, marker corrections, tracking corrections, line data, generated artifacts, and resumable batch-job states.

## Comments

## Answer

The MVP uses durable records for tracks, events, reusable timing imports, local video inputs, analyses, versioned correction sets, resumable processing runs, artifact references, observed line data, and named/versioned alternative lines.

SQLite stores metadata, relationships, lifecycle state, correction history, and references to large local artifacts. Processing runs expose explicit phases and checkpoints, including `needs_correction`; failed work can resume from the last valid checkpoint. Corrections are append-only, timing imports are reusable across analyses, and alternative lines are multiple named versions attached to an analysis.
