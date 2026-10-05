import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["api/test/**/*.spec.ts", "client/src/app/app/timing-selection.spec.ts", "client/src/app/app/browser-sqlite.spec.ts", "client/src/app/app/green-marker-detector.spec.ts", "client/src/app/app/calibration-state.spec.ts", "client/src/app/app/sqlite-asset-url.spec.ts"] } });
