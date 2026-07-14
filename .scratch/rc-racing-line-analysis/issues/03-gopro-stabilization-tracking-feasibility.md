Type: research
Status: resolved

## Question

Assess the feasibility and minimum viable pipeline for head-mounted GoPro footage: automatic green-corner-marker detection with correction, track stabilization from those markers, selected-car tracking from a user bounding box, confidence reporting, and manual re-identification after loss.

## Comments

## Answer

The GoPro pipeline is feasible as an operator-assisted TypeScript-first batch workflow.

Marker processing is two-phase: scan for green-marker observations, let the user review and correct the candidate marker map, then run the full analysis. Stabilization chooses its model automatically, starting with an affine transform and escalating to a homography when marker diagnostics justify it. A segment with an invalid marker transform is blocked from producing a track-relative racing line.

The selected car is initialized from a user-drawn bounding box. An optional description such as “blue buggy” is stored as metadata and may help a learned re-identification provider, but does not override the box or temporal continuity. The primary tracker emits explicit `tracked`, `suspect`, `lost`, and `reacquired` states. Lost intervals remain visible and are not silently interpolated; the user must draw a new box to resume.

Learned providers such as SAM 3 remain optional benchmark or re-detection paths rather than MVP requirements.
