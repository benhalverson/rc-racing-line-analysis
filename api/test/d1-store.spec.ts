import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1AnalysisStore } from "../src/d1-store";

const d1 = vi.hoisted(() => {
  let insertedRow: Record<string, unknown> | undefined;
  return {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        insertedRow = row;
        return { run: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get: vi.fn(() => insertedRow) })),
      })),
    })),
    reset: () => { insertedRow = undefined; },
  };
});

vi.mock("drizzle-orm/d1", () => ({ drizzle: vi.fn(() => d1) }));

describe("D1AnalysisStore video persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    d1.reset();
  });

  it("normalizes a browser URI when no local reference is supplied", async () => {
    await new D1AnalysisStore({} as D1Database).createDraft({ videoPath: "browser-sqlite://video-1", videoName: "race.mp4" });

    const row = d1.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(row.videoPath).toBe("browser-sqlite://video-1");
    expect(JSON.parse(row.localVideoRef)).toMatchObject({ id: "video-1" });
  });

  it("uses the supplied local reference ID over the video path", async () => {
    await new D1AnalysisStore({} as D1Database).createDraft({
      videoPath: "browser-sqlite://path-id",
      videoName: "race.mp4",
      localVideoRef: { id: "ref-id", name: "race.mp4", mimeType: "video/mp4", size: 10, lastModified: 1 },
    });

    const row = d1.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(row.videoPath).toBe("browser-sqlite://ref-id");
    expect(JSON.parse(row.localVideoRef).id).toBe("ref-id");
  });

  it("keeps the existing fallback for a plain non-browser path", async () => {
    await new D1AnalysisStore({} as D1Database).createDraft({ videoPath: "/races/heat-1.mp4", videoName: "heat-1.mp4" });

    const row = d1.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(row.videoPath).toBe("browser-sqlite:///races/heat-1.mp4");
    expect(JSON.parse(row.localVideoRef)).toMatchObject({ id: "/races/heat-1.mp4" });
  });
});
