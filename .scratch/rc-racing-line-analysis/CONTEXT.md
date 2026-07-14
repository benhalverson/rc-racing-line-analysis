# RC Racing Line Analysis Context

## Glossary

- **Analysis** — A post-race interpretation of one local video and one user-selected car, producing track-relative observations and review artifacts.
- **CV provider** — A replaceable component that turns video frames and operator corrections into marker, transform, tracking, or segmentation observations.
- **Production CV path** — The required runtime path for the application; it is TypeScript/Node.js based for the MVP and must not depend on Python.
- **Benchmark adapter** — An optional experimental provider used to compare another computer-vision runtime or model against the production path. Its presence does not change the product runtime contract.
- **Track-relative observation** — A car position or motion observation expressed against the stabilized track reference rather than only in raw camera pixels.
- **Timing import** — A user-initiated fetch, parse, validation, and SQLite write of one selected LiveRC race result and its individual lap records.
- **Timing record** — The normalized local representation of one selected race result, including its event, heat/main, class, driver, and lap times.
- **Marker map** — The accepted set of green track-marker identities and reference positions used to estimate camera-to-track transforms.
- **Tracking state** — The quality state of a selected-car observation: `tracked`, `suspect`, `lost`, or `reacquired`.
- **Lost interval** — A span of video for which the selected-car position is not trustworthy and is therefore not silently filled in.
- **Re-identification** — A user-confirmed or provider-assisted restart of selected-car tracking after a lost interval; it never silently changes the selected identity.
- **Observed line** — The track-relative path reconstructed from the selected car’s accepted video observations.
- **Alternative line** — A user-drawn hypothetical path used for geometry comparison; it has no measured race time.
- **Line length** — The estimated geometric distance along an observed or alternative path for a selected lap or segment.
- **Measured evidence** — A value grounded in imported LiveRC timing, aligned video, accepted tracking, or validated stabilization diagnostics.
- **Correction set** — A versioned collection of operator decisions that calibrates or repairs one analysis.
- **Processing run** — One resumable execution of an analysis, with an explicit phase, progress, checkpoint, and outcome.
- **Artifact** — A generated local file referenced by an analysis, such as observations, transforms, line data, overlays, or annotated video.
- **Alternative line version** — A named revision of a hypothetical user-drawn path retained for reproducible comparison.
