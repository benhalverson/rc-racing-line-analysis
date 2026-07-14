# ADR-0004: Separate Measured Race Evidence from Hypothetical Lines

## Status

Accepted

## Context

The teaching workflow combines two kinds of information: a selected car's actual race footage and LiveRC timing, plus lines the user draws to explore alternatives. A drawn line has no measured race execution or lap time.

## Decision

The review screen will keep measured evidence and hypothetical exploration visibly distinct.

Measured evidence includes:

- LiveRC lap duration and race-result fields;
- the video segment aligned to that lap;
- the observed track-relative car path;
- line geometry calculated from observed tracking data;
- stabilization and tracking quality states.

Hypothetical alternatives include:

- user-drawn path geometry;
- line length and corner entry/apex/exit comparisons;
- curvature/smoothness comparisons;
- warnings and uncertainty inherited from the underlying track reference.

The MVP will not assign an alternative a predicted lap time or claim that it is faster. The review workflow uses a user-marked start/finish line, automatic crossing detection, and manual crossing correction to align LiveRC lap records to video segments.

## Consequences

- Users can explore candidate lines without confusing geometric comparison with race evidence.
- A shorter line is not presented as automatically faster.
- The review UI must label hypothetical alternatives and show evidence quality beside measurements.
- Later simulation or prediction work would require a separate decision and validation basis.
