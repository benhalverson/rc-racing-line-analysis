Type: prototype
Status: resolved
Blocked by: 02, 03

## Question

Produce and validate a rough review workflow that synchronizes original video, tracked-car overlay, stabilized track-relative line, LiveRC lap times, and user-drawn alternative lines. Decide which comparisons are measured facts, which are geometry-only heuristics, and how uncertainty is shown.

## Comments

## Answer

The validated review workflow is represented by [the throwaway prototype](../prototype/review-workflow.html).

Measured evidence and hypothetical exploration remain visibly distinct. LiveRC supplies lap duration; the video supplies the aligned segment and observed track-relative path; accepted tracking and stabilization supply quality states. The user marks start/finish, the app detects crossings, and the user can correct lap assignments.

Alternative lines are user-drawn hypotheses. The MVP compares line length, corner entry/apex/exit positions, curvature/smoothness, and uncertainty, but does not predict lap time or claim that an alternative is faster. A shorter line is not treated as automatically faster.
