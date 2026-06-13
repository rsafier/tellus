import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("./tellus-urls-identity", () => ({
  tellusWorldChunkUrl: (cx: number, cz: number) => `https://test/chunk/${cx}/${cz}`,
}));

import {
  createChunkRenderer,
  createChunkTerrainGeometry,
} from "./tellus-chunk-renderer";
import {
  CHUNK_SEGMENTS,
  CHUNK_SPAN,
  CHUNK_VERTEX_COUNT,
} from "./tellus-constants";
import type { ChunkData } from "./world-protocol";

function makeChunk(over: Partial<ChunkData> = {}): ChunkData {
  return {
    cx: 0,
    cz: 0,
    revision: 0,
    segments: CHUNK_SEGMENTS,
    sculptOffsets: [],
    paint: [],
    ...over,
  };
}

describe("createChunkTerrainGeometry", () => {
  it("renders a flat chunk (empty sculptOffsets) with all y === 0", () => {
    const geometry = createChunkTerrainGeometry(makeChunk());
    const pos = geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBe(0);
    }
  });

  it("has CHUNK_VERTEX_COUNT² vertices at full LOD", () => {
    const geometry = createChunkTerrainGeometry(makeChunk());
    expect(geometry.getAttribute("position").count).toBe(
      CHUNK_VERTEX_COUNT * CHUNK_VERTEX_COUNT,
    );
    const index = geometry.getIndex();
    expect(index?.count).toBe(CHUNK_SEGMENTS * CHUNK_SEGMENTS * 6);
  });

  it("decimates to (seg+1)² vertices at lodSegments=16", () => {
    const geometry = createChunkTerrainGeometry(makeChunk(), 16);
    expect(geometry.getAttribute("position").count).toBe(17 * 17);
    expect(geometry.getIndex()?.count).toBe(16 * 16 * 6);
  });

  it("spans local x/z in [0, CHUNK_SPAN] regardless of chunk world coords", () => {
    const geometry = createChunkTerrainGeometry(makeChunk({ cx: 3, cz: 4 }));
    const pos = geometry.getAttribute("position");
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
      minZ = Math.min(minZ, pos.getZ(i));
      maxZ = Math.max(maxZ, pos.getZ(i));
    }
    expect(minX).toBe(0);
    expect(maxX).toBe(CHUNK_SPAN);
    expect(minZ).toBe(0);
    expect(maxZ).toBe(CHUNK_SPAN);
  });

  it("surfaces a nonzero sculpt offset at the matching vertex", () => {
    const offsets = new Array(CHUNK_VERTEX_COUNT * CHUNK_VERTEX_COUNT).fill(0);
    const xi = 10;
    const zi = 20;
    offsets[zi * CHUNK_VERTEX_COUNT + xi] = 7.5;
    const geometry = createChunkTerrainGeometry(
      makeChunk({ revision: 1, sculptOffsets: offsets }),
    );
    const pos = geometry.getAttribute("position");
    // Full LOD: vertex index in the built grid is j*(seg+1)+i with i=xi, j=zi.
    const vtx = zi * CHUNK_VERTEX_COUNT + xi;
    expect(pos.getY(vtx)).toBeCloseTo(7.5, 5);
  });
});

describe("createChunkRenderer lifecycle", () => {
  // A controllable fetch: each chunk URL resolves only when we call its deferred.
  let pending: Map<string, (data: ChunkData) => void>;

  beforeEach(() => {
    pending = new Map();
    vi.stubGlobal("fetch", (url: string) => {
      const m = /\/chunk\/(-?\d+)\/(-?\d+)/.exec(url);
      const cx = Number(m![1]);
      const cz = Number(m![2]);
      return new Promise((resolve) => {
        pending.set(`${cx},${cz}`, (data: ChunkData) =>
          resolve({ ok: true, json: () => Promise.resolve(data) } as Response),
        );
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const resolveAll = async () => {
    for (const [k, done] of pending) {
      const [cx, cz] = k.split(",").map(Number);
      done(makeChunk({ cx, cz, revision: 1 }));
    }
    pending.clear();
    // Flush the full fetch -> json() -> ready.set microtask chain.
    await new Promise((res) => setTimeout(res, 0));
  };

  it("builds the load ring and uniform full-res LOD (no per-ring decimation -> no seam cracks)", async () => {
    const scene = new THREE.Scene();
    const r = createChunkRenderer(scene);
    r.update(CHUNK_SPAN * 10 + 1, CHUNK_SPAN * 10 + 1); // center chunk (10,10)
    await resolveAll();
    r.flush();
    expect(r.stats().active).toBe(5 * 5); // CHUNK_LOAD_RADIUS=2 -> 5x5
    // every built chunk is full-res (uniform LOD): 65^2 verts.
    const group = scene.getObjectByName("tellus-chunk-terrain") as THREE.Group;
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      expect(mesh.geometry.getAttribute("position").count).toBe(
        CHUNK_VERTEX_COUNT * CHUNK_VERTEX_COUNT,
      );
    }
    r.dispose();
  });

  it("does NOT build a fetched chunk that drifted out of keep-radius before flush (evict race)", async () => {
    const scene = new THREE.Scene();
    const r = createChunkRenderer(scene);
    const group = scene.getObjectByName("tellus-chunk-terrain") as THREE.Group;

    // Load + fully fetch the ring around (10,10) so chunks sit in `ready` (fetched, not yet flushed).
    r.update(CHUNK_SPAN * 10 + 1, CHUNK_SPAN * 10 + 1);
    await resolveAll();
    // No flush yet: the 5x5 ring is parked in `ready`. Jump far so ALL of them exit keep-radius.
    r.update(CHUNK_SPAN * 80 + 1, CHUNK_SPAN * 80 + 1);
    r.flush();

    // The pre-fix bug: those ready chunks (not active, not inflight) survived the evict scan and flush()
    // built them as orphan meshes far outside the view. After the fix: zero orphans.
    expect(r.stats().active).toBe(0);
    expect(group.children.length).toBe(0);
    r.dispose();
  });
});
