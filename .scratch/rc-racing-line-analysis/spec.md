# RC Racing Line Analysis MVP

## Problem Statement

After an RC-car race, a driver has video from a head-mounted GoPro but no practical way to turn that footage into a track-relative racing line and compare it with the actual race timing. Screen-space motion is distorted by camera movement, and a user-drawn “better” line must not be presented as proven faster without measured race evidence.

## Solution

Build a local-first web app that imports one GoPro race video, imports the matching LiveRC timing record, detects and corrects green track markers, stabilizes the track view, tracks one user-selected car, aligns video segments to LiveRC laps, and presents a review workspace. The user can draw multiple named alternative lines and compare their geometry with the observed line while seeing uncertainty and measured timing clearly separated.

## User Stories

1. As a driver, I want to open the app locally, so that my race video stays on my machine.
2. As a driver, I want to select a LiveRC track by searching its racetrack or hobby-shop name, so that I do not need to know its hostname.
3. As a driver, I want to choose the exact matching track when search results contain multiple matches, so that timing data comes from the correct venue.
4. As a driver, I want to browse and search archived events for the selected track, so that I can find the race represented by my video.
5. As a driver, I want to select an exact event, so that results from similarly named events are not mixed.
6. As a driver, I want to select the exact heat or main event, so that repeated class labels do not produce the wrong lap record.
7. As a driver, I want to enter the class and driver name exactly as shown by LiveRC, so that the app can find my result.
8. As a driver, I want to confirm the matching timing record before analysis, so that duplicate names or entries cannot silently select the wrong car.
9. As a driver, I want the app to import individual lap times from LiveRC, so that video segments can be aligned to actual race timing.
10. As a driver, I want imported timing data cached in SQLite, so that I can review an analysis offline.
11. As a driver, I want to choose a local GoPro file, so that I can analyze a completed race without uploading it.
12. As a driver, I want to set the video point representing race start, so that video time can be aligned with the race.
13. As a driver, I want green track markers detected automatically, so that calibration does not require clicking every marker.
14. As a driver, I want to review and correct the detected marker map, so that incorrect detections do not distort the racing line.
15. As a driver, I want the app to choose a suitable stabilization transform automatically, so that I do not need to understand affine transforms or homographies.
16. As a driver, I want invalid stabilization segments blocked from line analysis, so that the app does not show a false track-relative path.
17. As a driver, I want to draw a box around the car I want to study, so that the app tracks the correct car.
18. As a driver, I want to optionally describe the car, such as “blue buggy,” so that future learned providers can use appearance information during re-identification.
19. As a driver, I want tracking quality shown as `tracked`, `suspect`, `lost`, or `reacquired`, so that I know which observations are trustworthy.
20. As a driver, I want lost intervals shown instead of silently filled, so that I can judge the limits of the analysis.
21. As a driver, I want to draw a new box after tracking is lost, so that analysis can continue after I confirm the car’s identity.
22. As a driver, I want start/finish crossings detected from the stabilized track view, so that LiveRC lap records can be attached to video segments.
23. As a driver, I want to correct missed or false crossing detections, so that lap alignment remains accurate.
24. As a driver, I want to see the original video with the tracked-car overlay, so that I can verify what the system observed.
25. As a driver, I want to see the observed path on a stabilized track-relative view, so that I can study the line independently of camera movement.
26. As a driver, I want to see each LiveRC lap time beside its video segment, so that timing and driving choices can be discussed together.
27. As a driver, I want to see line length, corner entry/apex/exit positions, curvature, and smoothness, so that I can compare driving geometry.
28. As a driver, I want to draw multiple alternative lines, so that I can explore different corner strategies.
29. As a driver, I want to name each alternative line, so that comparisons remain understandable.
30. As a driver, I want alternative lines versioned, so that earlier ideas remain reproducible.
31. As a driver, I want alternative lines labeled hypothetical, so that geometry comparisons are not confused with measured race performance.
32. As a driver, I want the app not to predict an alternative lap time, so that it does not overstate what the evidence proves.
33. As a driver, I want to rerun analysis after corrections without re-importing the video or timing, so that iteration is practical.
34. As a driver, I want long processing to show phase, progress, and checkpoints, so that I know whether work is advancing.
35. As a driver, I want failed processing to explain its last successful phase, so that I can correct the cause or retry.
36. As a driver, I want generated artifacts referenced from SQLite while large files remain on disk, so that the local database stays manageable.

## Implementation Decisions

- The application is a local web app with Angular UI, Hono API, SQLite persistence, and offline batch processing.
- The highest application seam is an `AnalysisWorkflow` service. It coordinates user-visible analysis lifecycle and depends on ports for timing import, CV providers, SQLite persistence, and local artifact storage. Hono remains a thin transport layer.
- The production CV path is TypeScript/Node.js. ONNX-compatible inference and Node/WebAssembly-compatible image/video primitives are preferred. Python or SAM 3 may be used only by an optional benchmark or re-detection adapter.
- The durable domain includes Track, Event, TimingImport, VideoInput, Analysis, CorrectionSet, ProcessingRun, Artifact, ObservedLine, and AlternativeLine.
- A TimingImport is reusable across analyses and contains normalized track, event, heat/main, class, driver, result, and individual lap data plus lightweight provenance. Raw HTML is not retained.
- The LiveRC flow is track search, exact track selection, event search/selection, exact heat/main selection, class and driver selection, confirmation, and import.
- The video flow is local file selection, manual race-start point, automatic marker scan, marker-map review/correction, car box selection, optional description, and batch processing.
- Stabilization uses an automatic graduated strategy: begin with an affine transform and escalate to a homography when marker diagnostics require it. Invalid marker transforms block track-relative output for that segment.
- The primary tracker starts from the user’s box. Learned providers are optional and must not silently replace the selected identity.
- Tracking states are `tracked`, `suspect`, `lost`, and `reacquired`. Lost intervals are preserved and require manual re-boxing to resume.
- Processing states are `draft`, `awaiting_calibration`, `ready`, `queued`, `running`, `needs_correction`, `completed`, `failed`, and `cancelled`. Runs record phase, progress, checkpoint, provider/version, and errors.
- Corrections are append-only and versioned. Reruns select an accepted correction-set version.
- SQLite stores metadata, relationships, lifecycle state, correction history, and artifact references. Large observation files, transforms, rendered overlays, and annotated video remain local files.
- The review workspace combines original video, tracked overlay, stabilized track view, LiveRC lap table, observed line, named alternatives, geometry metrics, and evidence warnings.
- Measured evidence includes LiveRC timing, aligned video, accepted tracking, and stabilization diagnostics. Alternative lines are geometry-only hypotheses; the MVP does not predict their lap times or call them faster.
- The prototype’s evidence/alternative distinction and review layout are captured in the throwaway review workflow prototype.

## Testing Decisions

- Tests should exercise external behavior through `AnalysisWorkflow`, using fake timing/CV/artifact ports and an in-memory or temporary SQLite database. Tests should not couple to internal helper functions.
- Test the timing importer with representative LiveRC page fixtures: exact track selection, duplicate tracks, repeated heats/mains, duplicate names, missing lap data, parser provenance, and normalized lap values.
- Test the analysis lifecycle: valid transitions, `needs_correction`, checkpoint resume, cancellation, failure reporting, and reruns from a selected correction-set version.
- Test correction behavior: marker correction, start/finish correction, car re-boxing, lost intervals, and preservation of prior versions.
- Test CV-provider behavior through provider contracts: marker quality gating, affine/homography selection, tracked/suspect/lost/reacquired states, and no silent identity switch.
- Test artifact behavior through a temporary local artifact store: deterministic references, replacement on rerun, and metadata remaining in SQLite.
- Test the Hono API as a thin adapter over the workflow using request/response behavior, not implementation details.
- Test the Angular review workflow with user-visible scenarios: import selection, calibration correction, processing progress, video/track synchronization, warnings, alternative-line naming, and geometry-only labels.
- The repository has no prior application test patterns yet; establish these as the initial testing conventions for the greenfield project.

## Out of Scope

- Live or near-live processing.
- Cloud upload, hosted analysis, or cloud storage.
- Automatic car identity selection.
- Multi-car analysis in one review.
- Automatically generated fastest lines or predicted alternative lap times.
- The static NorCal Hobbies stream as an initial source profile.
- Multi-camera fusion, moving-camera profiles beyond the head-mounted GoPro, and live race assistance.
- Raw LiveRC HTML archival.

## Further Notes

- The planning source of truth is the completed wayfinding map and its linked ADRs, research notes, glossary, and prototype.
- The implementation should start with the smallest vertical slice through `AnalysisWorkflow`, likely local project shell, SQLite lifecycle model, and one import/process/review path.
- The spec is intended to be split into dependency-ordered tracer-bullet tickets next.
