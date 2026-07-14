Type: grilling
Status: resolved

## Question

Given the TypeScript/Node.js preference, where should the MVP’s video decoding, stabilization, green-marker detection, selected-car tracking, and artifact generation run? Decide the local processing boundary, including when a Python/FastAPI sidecar is justified.

## Comments

## Answer

The production computer-vision path will be TypeScript/Node.js based. The MVP will use an ONNX-compatible inference provider and Node- or WebAssembly-compatible image/video primitives where practical, behind replaceable CV provider interfaces.

Python or SAM 3 may be used only through an optional benchmark adapter to evaluate quality on representative GoPro footage. Python is not a required production dependency for the MVP.
