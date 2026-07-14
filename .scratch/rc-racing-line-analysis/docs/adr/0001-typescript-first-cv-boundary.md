# ADR-0001: Keep the Production CV Path TypeScript-First

## Status

Accepted

## Context

The application is intended to start as a local web app but may become serverless or browser-assisted later. The computer-vision work includes video processing, green-corner-marker detection, camera stabilization, selected-car tracking, and possibly learned segmentation. Python/OpenCV and SAM 3 may offer useful experimentation advantages, but making Python a required runtime would create a harder deployment boundary.

## Decision

The required MVP computer-vision path will remain TypeScript/Node.js based. Learned inference will use an ONNX-compatible provider, and image/video primitives will use a Node- or WebAssembly-compatible provider where practical. CV capabilities will sit behind replaceable provider interfaces.

Python or SAM 3 may be used through an optional benchmark adapter when evaluating quality on representative GoPro footage. That adapter cannot become a required production dependency unless a later decision explicitly changes this boundary.

## Consequences

- The Hono API and local batch worker retain a path toward browser, serverless, or other JavaScript runtimes.
- The first prototype must measure whether TypeScript-compatible video and vision libraries are adequate for the real footage.
- A temporary Python benchmark can answer quality questions without defining the application architecture.
- Some mature computer-vision capabilities may require additional native bindings, WASM packaging, or a deliberate reduction in model scope.
