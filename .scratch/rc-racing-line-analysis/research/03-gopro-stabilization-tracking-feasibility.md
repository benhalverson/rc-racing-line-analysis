# GoPro stabilization and selected-car tracking feasibility

## Conclusion

This pipeline is feasible as a local, offline MVP. The lowest-risk design is a Python/OpenCV worker for frame processing, with TypeScript/Node responsible for job submission, progress, metadata, and artifact management. A TypeScript-only implementation is possible for orchestration and ONNX inference, but the marker/stabilization path would require either a native OpenCV binding/build or a separate Python process; OpenCV's official JavaScript tutorials are framed around OpenCV.js in web pages, so they are not evidence of a mature Node video-processing API ([OpenCV.js tutorials](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html)).

The MVP should be explicitly operator-assisted:

1. Read a GoPro file and normalize/decode it with FFmpeg or OpenCV.
2. Detect the green corner markers using HSV thresholding, morphology, contours, and geometric filtering.
3. Estimate a frame-to-reference transform from accepted marker correspondences and warp the frame or the tracked coordinates.
4. Ask the user for an initial bounding box around the selected car.
5. Track that box frame-to-frame; record the tracker result, tracker health, and marker/transform quality for every frame.
6. Stop claiming a valid track after configurable consecutive failures, emit a lost interval, and let the user choose a new box to reinitialize.

This is suitable for batch analysis and review. It is not enough, by itself, to promise identity-preserving tracking through long occlusions, car-to-car overlap, severe blur, or a complete view exit.

## Evidence from primary documentation

### Marker detection

OpenCV documents fixed thresholding, adaptive thresholding, and Otsu thresholding, and notes that adaptive thresholding is useful when illumination varies across an image ([OpenCV image thresholding](https://docs.opencv.org/4.x/d7/d4d/tutorial_py_thresholding.html)). For green markers, the practical first pass is to convert BGR to HSV, threshold a calibrated hue/saturation/value range, and apply morphology. The thresholds should be configurable per camera/track rather than hard-coded as a universal green value.

OpenCV's contour documentation recommends using binary images before `findContours`, describes contours as useful for shape analysis/object detection, and exposes `findContours` plus contour geometry operations ([OpenCV contours](https://docs.opencv.org/4.x/d4/d73/tutorial_py_contours_begin.html)). That is enough to select marker candidates by area, aspect ratio, solidity/convexity, expected corner region, and inter-marker spacing. A marker detector should return both candidate observations and a quality score; it should not silently choose a candidate when multiple blobs pass weak filters.

If the markers are deliberately designed, ArUco/AprilTag-style encoded fiducials would be more robust than plain green blobs, but that changes the physical marker requirement. For the stated green-corner-marker requirement, color plus contour geometry is the smallest viable implementation.

### Stabilization from markers

OpenCV provides geometric motion models—translation, Euclidean, affine, and homography—and ECC-based transform estimation in its video tracking API ([OpenCV video tracking and motion estimation](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)). With four or more known marker points, `findHomography` can estimate a projective mapping and optionally use a robust method/mask ([OpenCV `findHomography`](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)).

Recommended MVP behavior:

- Define a reference frame or a reference marker layout in image coordinates.
- Detect markers independently in each frame.
- Accept a transform only when enough distinct markers are present and the reprojection error, inlier mask, scale, rotation, and crop bounds are plausible.
- Use a rigid/affine model first if the track is effectively planar and the camera movement is moderate; use homography only when perspective change justifies it.
- Smooth transform parameters over time and crop/zoom conservatively to avoid exposing black borders.
- Preserve the raw frame and raw observations. Stabilization must be a derived artifact so a bad transform can be diagnosed or recomputed.

The marker transform is especially valuable because it gives a camera-motion estimate independent of the selected-car tracker. The selected-car box can be transformed into the stabilized coordinate system, or tracking can be performed after warping. The former avoids repeatedly resampling the video; the latter can make visual review easier. Pick one coordinate convention and store both raw-frame and stabilized-frame coordinates.

For wide-angle GoPro footage, lens distortion can make a single planar transform less reliable near the image edges. OpenCV has a dedicated fisheye calibration model and calibration/undistortion APIs ([OpenCV fisheye calibration](https://docs.opencv.org/4.x/db/d58/group__calib3d__fisheye.html)). Calibration is not required to prove the MVP, but a per-camera calibration profile is a likely follow-up if corner-marker reprojection errors vary systematically by image location.

### Tracking from an initial bounding box

OpenCV's tracker API directly matches the requested interaction: initialize with a known bounding box, then call `update` for subsequent frames. The CSRT documentation states that `init` initializes from a known bounding box and `update` finds the most likely new box; the API returns a boolean from `update` ([OpenCV `TrackerCSRT`](https://docs.opencv.org/master/d2/da2/classcv_1_1TrackerCSRT.html)). OpenCV's tracker tutorial demonstrates the same select-ROI → initialize → update workflow and notes that the initial box must have non-zero size ([OpenCV tracker tutorial](https://docs.opencv.org/master/d2/d0a/tutorial_introduction_to_tracker.html)).

CSRT is a sensible first candidate when the car has enough visual texture and scale/aspect changes matter. KCF or MOSSE may be faster but are more dependent on favorable appearance and may be less forgiving. The current OpenCV API also documents lightweight DNN trackers such as Nano, but that adds model/runtime assets and should be benchmarked rather than assumed to be better ([OpenCV object tracking API](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)).

For a second tracking path, Ultralytics documents video tracking with persistent state (`persist=True`) and warns that persistence is for consecutive frames from the same stream ([Ultralytics tracking mode](https://docs.ultralytics.com/modes/track)). This is useful when the operator's box can seed or validate a detector-based tracker, but it is not a substitute for explicit identity management: generic detections can switch to a visually similar car unless the pipeline checks spatial continuity, appearance, and track quality.

### Confidence, lost-track recovery, and manual re-identification

No single tracker confidence value should be treated as ground truth. The report should expose a composite quality record per frame, for example:

- `trackerUpdateOk`: the tracker accepted the frame (`update` boolean where available).
- `boxGeometry`: box area, aspect-ratio change, velocity jump, and image-boundary proximity.
- `appearance/association`: optional detector or template similarity to the initial car.
- `markerQuality`: number of accepted markers, inlier count, reprojection error, and transform plausibility.
- `state`: `tracked`, `suspect`, `lost`, or `reacquired`.

The state machine should enter `suspect` on one weak signal, enter `lost` after a small configurable run of failures, and stop exporting a continuous car path during the lost interval. Do not extrapolate indefinitely from the last box. A Kalman filter is available in OpenCV's video-tracking API ([OpenCV video tracking API](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)); it can smooth short gaps or provide a bounded prediction, but it should not turn an unobserved car into a claimed observation.

Manual re-identification is practical and should be a first-class event: pause or seek to a review frame, let the operator draw a new box, initialize a fresh tracker, increment a segment/reacquisition identifier, and continue with a visible boundary in the output. The OpenCV initialization contract supports this reset model. For long or ambiguous losses, require confirmation instead of automatically attaching the new box to the old identity.

### Local batch processing

OpenCV's video I/O API supports reading from video files frame-by-frame with `VideoCapture`, checking the boolean returned by `read`, inspecting frame properties, and writing output with `VideoWriter` ([OpenCV video I/O tutorial](https://docs.opencv.org/4.x/dd/d43/tutorial_py_video_display.html)). That is sufficient for a sequential local worker and avoids requiring a live camera path.

FFmpeg is a strong companion for media normalization and final muxing. Its official documentation describes it as a media converter that can read many inputs and filter/transcode them, and explains that filtering requires transcoding while stream copy avoids unnecessary re-encoding ([FFmpeg documentation](https://ffmpeg.org/ffmpeg.html)). FFmpeg's `vidstabdetect`/`vidstabtransform` filters provide a conventional two-pass deshake path based on relative translation and rotation transforms ([FFmpeg filters: `vidstabdetect`](https://ffmpeg.org/ffmpeg-filters.html#vidstabdetect), [FFmpeg filters: `vidstabtransform`](https://ffmpeg.org/ffmpeg-filters.html#vidstabtransform)). That built-in stabilization is a useful baseline, but it is not marker-anchored; marker-based stabilization remains preferable when the track geometry is the desired reference.

The worker should process one file sequentially, write progress and structured per-frame results incrementally, and make output paths deterministic. It should support a no-render mode that produces JSON/CSV observations without encoding a full annotated video. Annotated video is useful for QA but is more expensive and introduces codec/container failure modes.

## Runtime options

### Python/OpenCV worker — recommended for the CV core

Python has the most direct path to OpenCV's documented Python APIs, NumPy array operations, OpenCV video I/O, and the Python ecosystem around vision models. A worker can be invoked as a normal local process and can emit JSON lines or a result file while processing. Ultralytics is an optional detector/tracker component when classical tracking is not sufficient.

Advantages: lowest integration risk for color/contour/geometry, easiest experimentation, strong batch-script ergonomics, and direct access to the documented `cv2` APIs. Risks: native OpenCV packaging and codec availability still need to be tested on the target machine; model-based tracking adds model downloads, licensing review, and calibration work.

### TypeScript/Node coordinator or inference path

ONNX Runtime officially provides a Node.js binding installable as `onnxruntime-node`, with prebuilt CPU binaries for Windows x64/arm64, Linux x64/arm64, and macOS x64/arm64; its documented accelerator matrix is narrower ([ONNX Runtime Node.js binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)). ONNX Runtime also documents the server-side JavaScript use case and explicitly identifies `onnxruntime-node` for it ([ONNX Runtime web/server guidance](https://onnxruntime.ai/docs/tutorials/web/)). This makes TypeScript a credible option for model inference if the model is exported to ONNX, especially for a detector or embedding model.

Node's built-in `child_process.spawn` can run FFmpeg or a Python worker, stream stdout/stderr, observe exit status, and support cancellation through an `AbortSignal` ([Node.js child process](https://nodejs.org/api/child_process.html)). Therefore the practical TypeScript architecture is a typed job coordinator around a Python/OpenCV subprocess, not a forced reimplementation of OpenCV in JavaScript.

TypeScript-only remains viable if the project accepts the native-binding/build risk and uses Node for media process control plus ONNX Runtime for learned inference. It is less attractive for the first MVP because marker extraction, geometric warping, tracker availability, and codec behavior would be split across packages with different native support matrices.

## Proposed MVP boundary

The minimum useful experiment is one representative GoPro clip with known green marker placement:

- marker detection overlay and per-frame marker observations;
- marker-based transform overlay and reprojection/error diagnostics;
- operator-selected car box;
- CSRT (or a benchmarked alternative) track with explicit `tracked/suspect/lost/reacquired` states;
- a manual re-box action that creates a new track segment;
- JSON/CSV output for every frame, including missing observations and quality fields;
- optional annotated MP4 for visual review;
- a small benchmark report: wall-clock duration, frames processed, marker detection rate, transform acceptance rate, continuous-track percentage, lost intervals, and manual reacquisition count.

Do not make learned car detection a prerequisite for this experiment. Add it only if the initial-box tracker fails often enough on representative clips, and then use it as a periodic re-detection/validation signal rather than allowing detector IDs to silently replace the operator-selected identity.

## Main feasibility risks

- Plain green markers can be confused by grass, painted curbs, reflections, exposure changes, and motion blur. Marker placement, color calibration, minimum area, and temporal gating matter as much as the algorithm.
- A homography assumes a useful geometric relationship between marker observations. If markers are not on a common effective plane, the transform may stabilize the corners while distorting the rest of the image.
- Head motion and GoPro rolling shutter can produce non-global motion; one transform per frame may not remove all wobble.
- A box tracker can drift onto another car or track stale appearance after an occlusion. The system must publish uncertainty and lost intervals instead of hiding the failure.
- Output encoding is a separate operational concern. Keep analysis artifacts independent from rendered video so a codec failure does not discard the measurements.

## Recommendation

Proceed with a Python/OpenCV batch prototype behind a TypeScript/Node job boundary. Treat marker detection and marker-anchored stabilization as the primary deterministic path, use an initial-box OpenCV tracker for the selected car, and make loss plus manual re-identification part of the normal data model. Keep ONNX Runtime/Ultralytics as an optional validation or re-detection layer after the classical MVP has measured its real failure rate.
