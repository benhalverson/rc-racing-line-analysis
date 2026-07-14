import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["api/test/**/*.spec.ts", "client/src/app/app/timing-selection.spec.ts"] } });
