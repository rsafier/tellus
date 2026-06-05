import { describe, expect, it } from "vitest";
import { isTellusTerrainState, isWorldAction } from "./world-protocol";

const terrainState = {
  version: 2,
  revision: 12,
  terrainSculptOffsets: [0, 1, 2],
  terrainPaint: [0, 3, 4],
  distantIslandSculptOffsets: {
    north: [1, 2, 3],
  },
  distantIslandPaint: {
    north: [0, 1, 2],
  },
  savedAt: "2026-06-05T00:00:00.000Z",
};

describe("world protocol validators", () => {
  it("accepts complete terrain snapshots", () => {
    expect(isTellusTerrainState(terrainState)).toBe(true);
  });

  it("rejects malformed terrain arrays", () => {
    expect(
      isTellusTerrainState({
        ...terrainState,
        terrainSculptOffsets: [0, Number.NaN],
      }),
    ).toBe(false);
  });

  it("accepts terrain replace actions", () => {
    expect(
      isWorldAction({
        type: "terrain.replace",
        visitorId: "visitor-1",
        terrain: terrainState,
      }),
    ).toBe(true);
  });

  it("rejects generation requests without prompts", () => {
    expect(
      isWorldAction({
        type: "generation.request",
        visitorId: "visitor-1",
        request: { creatorId: "agent-1" },
      }),
    ).toBe(false);
  });
});
