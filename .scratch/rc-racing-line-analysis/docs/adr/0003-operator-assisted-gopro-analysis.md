# ADR-0003: Use an Operator-Assisted GoPro Analysis Pipeline

## Status

Accepted

## Context

Head-mounted GoPro footage changes viewpoint continuously. Green track markers can provide a stable reference, but marker visibility, blur, exposure, perspective, and car occlusion can make fully automatic analysis unreliable. The teaching tool must prefer an honest incomplete result over a silently incorrect racing line.

## Decision

The MVP uses a two-phase, operator-assisted pipeline:

1. Scan the video for green-marker observations and build a candidate marker map.
2. Let the user review and correct that map.
3. Choose the stabilization transform automatically, starting with an affine model and escalating to a homography when marker diagnostics justify it.
4. Run the selected-car tracker from a user-drawn bounding box.
5. Let the user optionally describe the car, such as “blue buggy”; this is metadata and a possible learned-provider re-identification hint, not an identity guarantee.
6. Preserve explicit tracking states: `tracked`, `suspect`, `lost`, and `reacquired`.
7. Block a track-relative line for any segment whose marker transform is invalid. Preserve lost intervals rather than silently interpolating them. Require a new user box to resume after a lost interval.

The initial-box tracker is the primary MVP tracker. Learned providers, including SAM 3, remain optional benchmark or re-detection providers.

## Consequences

- The workflow includes a review step before expensive full analysis.
- The output can explain where stabilization or tracking became unreliable.
- A valid racing line is not produced from unstable camera coordinates or unobserved car motion.
- The implementation needs per-frame marker, transform, tracker, and confidence artifacts.
- A later learned provider can use the optional description without changing the operator-facing contract.
