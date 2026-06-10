import * as THREE from "three";
import { MeshLambertNodeMaterial } from "three/webgpu";
import {
  attribute,
  dot,
  float,
  length,
  max,
  positionLocal,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { SEA_LEVEL, WORLD_RADIUS } from "./tellus-constants";
import type { TerrainPaintKind } from "./tellus-types";

// ── Ambient procedural vegetation ─────────────────────────────────────────────────────────────────
// Crysis-style ground cover for the central island: wind-swayed grass + flowers streamed in chunks
// around the player, plus an island-wide scatter of procedural low-poly trees and rocks. Everything
// is DETERMINISTIC (fixed seed + chunk coords + the synced terrain state), so every client grows the
// same world with no new protocol. Placement is terrain-aware (paint kind, height, slope, water) and
// re-grows lazily when the terrain is sculpted (locally or by a remote patch).
//
// Rendering strategy: each chunk is ONE merged BufferGeometry stamped into PRE-ALLOCATED buffers
// (drawRange-trimmed → zero steady-state allocation, one draw call per chunk). On WebGPU the grass
// material is a MeshLambertNodeMaterial whose positionNode adds per-vertex wind flutter, a traveling
// gust front, player-proximity bending, and a shrink-into-the-ground distance fade — driven by the
// per-vertex `aVegRoot` attribute (rootX, rootZ, phase, swayWeight). On the WebGL fallback (the
// renderer's own "simplified preview" mode) the same geometry renders with a plain Lambert material:
// static, but present. Trees and rocks are two more merged meshes rebuilt only on terrain change.

export interface VegetationOptions {
  scene: THREE.Scene;
  useWebGPU: boolean;
  sampleHeight: (x: number, z: number) => number;
  samplePaint: (x: number, z: number) => TerrainPaintKind | null;
  /** Extra exclusion test (e.g. the pond bowl) — return true to keep this spot clear. */
  isExcluded: (x: number, z: number, height: number) => boolean;
}

export interface VegetationStats {
  tier: number;
  chunks: number;
  grassIndices: number;
  trees: number;
}

export interface TreeCollider {
  x: number;
  z: number;
  r: number;
}

export interface VegetationSystem {
  /** Per-frame: stream chunks around (px, pz), update sway/bend uniforms, run queued rebuilds. */
  update(px: number, pz: number, playerY: number, fps: number, nowMs: number): void;
  /** The terrain was sculpted/painted (local or remote) — re-grow lazily. */
  notifyTerrainChanged(): void;
  /** Trunk collision circles for the player (world space). */
  getTreeColliders(): TreeCollider[];
  stats(): VegetationStats;
  dispose(): void;
}

// ── Deterministic PRNG ────────────────────────────────────────────────────────────────────────────

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const cellSeed = (cx: number, cz: number, salt: number) =>
  (Math.imul(cx + 512, 73856093) ^ Math.imul(cz + 512, 19349663) ^ salt) >>> 0;

// ── Layout constants ──────────────────────────────────────────────────────────────────────────────

const CHUNK = 12; // world units per streaming chunk
const HALF_WORLD = WORLD_RADIUS; // chunks cover [-72, 72]²
const GRID = Math.ceil((2 * HALF_WORLD) / CHUNK); // 12×12 chunk grid
const MAX_TUFTS = 360; // per-chunk cap (HIGH tier fills toward this)
const MAX_FLOWERS = 48;
const TUFT_CANDIDATES = 520; // deterministic candidate prefix shared by every tier

// Quality tiers — radius streams fewer chunks AND a smaller per-chunk cap. The accepted-candidate
// prefix is tier-independent, so tier flips trim/extend growth without reshuffling it.
const TIERS = [
  { radius: 18, density: 0.45 }, // 0 MIN
  { radius: 27, density: 0.7 }, // 1 LOW
  { radius: 36, density: 0.85 }, // 2 MED
  { radius: 44, density: 1.0 }, // 3 HIGH
] as const;

// Per-paint grass acceptance/styling. Null paint (the unpainted base) behaves like meadow.
const GRASS_BY_PAINT: Record<string, { accept: number; tint: number; tall: number }> = {
  meadow: { accept: 0.92, tint: 0x77ab40, tall: 1.0 },
  flowers: { accept: 0.85, tint: 0x86b148, tall: 0.92 },
  dirt: { accept: 0.3, tint: 0x9a9a52, tall: 0.7 },
  beach: { accept: 0.08, tint: 0xb9c46a, tall: 0.55 },
  rock: { accept: 0.05, tint: 0x7d9a55, tall: 0.6 },
  snow: { accept: 0.04, tint: 0xa9c9a0, tall: 0.5 },
};

const FLOWER_PALETTE = [0xffffff, 0xffd7e8, 0xffe9a8, 0xc9b8ff, 0xffb0a0, 0x9fd8ff];

// ── Template baking ───────────────────────────────────────────────────────────────────────────────
// A template is a small vertex soup (pos / normal / color / tintable / sway weight / index) stamped
// per placement into a chunk's buffers with yaw + scale + tint. Built once at init.

interface Template {
  pos: Float32Array; // xyz
  nrm: Float32Array;
  col: Float32Array; // rgb
  tintable: Uint8Array; // 1 = multiply by the stamp tint, 0 = keep the baked color
  sway: Float32Array; // per-vertex sway weight 0..1
  idx: Uint32Array;
}

const buildTemplateFromParts = (
  parts: Array<{
    geom: THREE.BufferGeometry;
    matrix: THREE.Matrix4;
    color: THREE.Color;
    tintable: boolean;
    /** sway weight ramps 0→1 from this (post-matrix) local height to the template top */
    swayFrom?: number;
  }>,
): Template => {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const tintable: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let maxY = 0.0001;
  const baked = parts.map((part) => {
    const g = part.geom.index ? part.geom.toNonIndexed() : part.geom;
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      maxY = Math.max(maxY, v.fromBufferAttribute(p, i).applyMatrix4(part.matrix).y);
    }
    return { part, g };
  });
  for (const { part, g } of baked) {
    const p = g.getAttribute("position");
    const gn = g.getAttribute("normal");
    nm.getNormalMatrix(part.matrix);
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(part.matrix);
      n.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      pos.push(v.x, v.y, v.z);
      nrm.push(n.x, n.y, n.z);
      col.push(part.color.r, part.color.g, part.color.b);
      tintable.push(part.tintable ? 1 : 0);
      const from = part.swayFrom ?? 0;
      const w = Math.max(0, (v.y - from) / Math.max(0.0001, maxY - from));
      sway.push(w * w);
      idx.push(base + i);
    }
    if (g !== part.geom) g.dispose();
    part.geom.dispose();
  }
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Float32Array(col),
    tintable: new Uint8Array(tintable),
    sway: new Float32Array(sway),
    idx: new Uint32Array(idx),
  };
};

/** A grass tuft: three crossed tapered blades, unit height, root→tip gradient, fully tintable. */
const buildGrassTemplate = (): Template => {
  const pos: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const idx: number[] = [];
  const rootColor = new THREE.Color(0x2c4a1c);
  const midColor = new THREE.Color(0x558030);
  const tipColor = new THREE.Color(0xffffff); // the tip takes the stamp tint fully
  const blade = (yaw: number, lean: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const base = pos.length / 3;
    // (acrossX, height, color, swayWeight) — the tip leans outward along the blade normal as y².
    const verts: Array<[number, number, THREE.Color, number]> = [
      [-0.085, 0, rootColor, 0],
      [0.085, 0, rootColor, 0],
      [-0.05, 0.55, midColor, 0.32],
      [0.05, 0.55, midColor, 0.32],
      [0, 1, tipColor, 1],
    ];
    for (const [x, y, color, w] of verts) {
      const bend = lean * y * y;
      pos.push(x * c + bend * s, y, -x * s + bend * c);
      col.push(color.r, color.g, color.b);
      sway.push(w * w);
    }
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  };
  blade(0, 0.16);
  blade(Math.PI / 3, 0.2);
  blade((2 * Math.PI) / 3, 0.13);
  const count = pos.length / 3;
  const nrm = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) nrm[i * 3 + 1] = 1; // constant up-normal: grass lit like the ground
  return {
    pos: new Float32Array(pos),
    nrm,
    col: new Float32Array(col),
    tintable: new Uint8Array(count).fill(1),
    sway: new Float32Array(sway),
    idx: new Uint32Array(idx),
  };
};

/** A flower: thin stem quad + two crossed head quads (only the head takes the petal tint). */
const buildFlowerTemplate = (): Template => {
  const pos: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const tintable: number[] = [];
  const idx: number[] = [];
  const stem = new THREE.Color(0x3d6526);
  {
    const base = pos.length / 3;
    pos.push(-0.03, 0, 0, 0.03, 0, 0, 0.022, 0.66, 0, -0.022, 0.66, 0);
    for (let i = 0; i < 4; i++) {
      col.push(stem.r, stem.g, stem.b);
      tintable.push(0);
    }
    sway.push(0, 0, 0.36, 0.36);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const headQuad = (yaw: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const base = pos.length / 3;
    const corners = [
      [-0.13, -0.13],
      [0.13, -0.13],
      [0.13, 0.13],
      [-0.13, 0.13],
    ];
    for (const [x, y] of corners) {
      pos.push(x * c, 0.74 + y, -x * s);
      col.push(1, 1, 1);
      tintable.push(1);
      sway.push(1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  headQuad(0);
  headQuad(Math.PI / 2);
  const count = pos.length / 3;
  const nrm = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) nrm[i * 3 + 1] = 1;
  return {
    pos: new Float32Array(pos),
    nrm,
    col: new Float32Array(col),
    tintable: new Uint8Array(tintable),
    sway: new Float32Array(sway),
    idx: new Uint32Array(idx),
  };
};

const buildRockTemplate = (): Template => {
  const geom = new THREE.IcosahedronGeometry(1, 0);
  const rng = mulberry32(47291);
  const p = geom.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).multiplyScalar(0.86 + rng() * 0.3);
    p.setXYZ(i, v.x, v.y * 0.62, v.z);
  }
  geom.computeVertexNormals();
  return buildTemplateFromParts([
    { geom, matrix: new THREE.Matrix4(), color: new THREE.Color(0xffffff), tintable: true },
  ]);
};

/** Two low-poly tree archetypes, unit height (scaled to 3.4–6.8 world units at stamp time). */
const buildTreeTemplates = (): { conifer: Template; broadleaf: Template } => {
  const at = (x: number, y: number, z: number) =>
    new THREE.Matrix4().makeTranslation(x, y, z);
  const trunk = new THREE.Color(0x6c4f33);
  const conifer = buildTemplateFromParts([
    { geom: new THREE.CylinderGeometry(0.035, 0.05, 0.26, 5), matrix: at(0, 0.13, 0), color: trunk, tintable: false },
    { geom: new THREE.ConeGeometry(0.3, 0.36, 7), matrix: at(0, 0.4, 0), color: new THREE.Color(0x2f6b33), tintable: true, swayFrom: 0.2 },
    { geom: new THREE.ConeGeometry(0.23, 0.32, 7), matrix: at(0, 0.62, 0), color: new THREE.Color(0x3a7c3a), tintable: true, swayFrom: 0.2 },
    { geom: new THREE.ConeGeometry(0.15, 0.28, 7), matrix: at(0, 0.84, 0), color: new THREE.Color(0x468b41), tintable: true, swayFrom: 0.2 },
  ]);
  const broadleaf = buildTemplateFromParts([
    { geom: new THREE.CylinderGeometry(0.04, 0.06, 0.42, 5), matrix: at(0, 0.21, 0), color: trunk, tintable: false },
    { geom: new THREE.IcosahedronGeometry(0.24, 0), matrix: at(0, 0.62, 0), color: new THREE.Color(0x4a8c38), tintable: true, swayFrom: 0.3 },
    { geom: new THREE.IcosahedronGeometry(0.18, 0), matrix: at(0.16, 0.52, 0.07), color: new THREE.Color(0x55983d), tintable: true, swayFrom: 0.3 },
    { geom: new THREE.IcosahedronGeometry(0.17, 0), matrix: at(-0.14, 0.55, -0.09), color: new THREE.Color(0x3f7d33), tintable: true, swayFrom: 0.3 },
  ]);
  return { conifer, broadleaf };
};

// ── Pooled chunk meshes ───────────────────────────────────────────────────────────────────────────

interface PooledMesh {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  pos: THREE.BufferAttribute;
  nrm: THREE.BufferAttribute;
  col: THREE.BufferAttribute;
  root: THREE.BufferAttribute; // aVegRoot: (rootX, rootZ, phase, swayWeight)
  index: THREE.BufferAttribute;
}

interface ActiveChunk {
  key: string;
  cx: number;
  cz: number;
  pooled: PooledMesh;
  rev: number;
  tier: number;
}

interface StampCursor {
  v: number; // vertex write head
  i: number; // index write head
}

const stampTemplate = (
  pooled: PooledMesh,
  cur: StampCursor,
  tpl: Template,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  tint: THREE.Color,
  phase: number,
  swayAmp: number,
): boolean => {
  const count = tpl.pos.length / 3;
  const pa = pooled.pos.array as Float32Array;
  const ia = pooled.index.array as Uint32Array;
  if ((cur.v + count) * 3 > pa.length || cur.i + tpl.idx.length > ia.length) return false;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const na = pooled.nrm.array as Float32Array;
  const ca = pooled.col.array as Float32Array;
  const ra = pooled.root.array as Float32Array;
  for (let i = 0; i < count; i++) {
    const lx = tpl.pos[i * 3] * scale;
    const ly = tpl.pos[i * 3 + 1] * scale;
    const lz = tpl.pos[i * 3 + 2] * scale;
    const o3 = (cur.v + i) * 3;
    pa[o3] = x + lx * c + lz * s;
    pa[o3 + 1] = y + ly;
    pa[o3 + 2] = z - lx * s + lz * c;
    const nx = tpl.nrm[i * 3];
    const nz = tpl.nrm[i * 3 + 2];
    na[o3] = nx * c + nz * s;
    na[o3 + 1] = tpl.nrm[i * 3 + 1];
    na[o3 + 2] = -nx * s + nz * c;
    if (tpl.tintable[i]) {
      ca[o3] = tpl.col[i * 3] * tint.r;
      ca[o3 + 1] = tpl.col[i * 3 + 1] * tint.g;
      ca[o3 + 2] = tpl.col[i * 3 + 2] * tint.b;
    } else {
      ca[o3] = tpl.col[i * 3];
      ca[o3 + 1] = tpl.col[i * 3 + 1];
      ca[o3 + 2] = tpl.col[i * 3 + 2];
    }
    const o4 = (cur.v + i) * 4;
    ra[o4] = x;
    ra[o4 + 1] = z;
    ra[o4 + 2] = phase;
    ra[o4 + 3] = tpl.sway[i] * swayAmp;
  }
  for (let i = 0; i < tpl.idx.length; i++) ia[cur.i + i] = tpl.idx[i] + cur.v;
  cur.v += count;
  cur.i += tpl.idx.length;
  return true;
};

const markPooledUpdated = (pooled: PooledMesh, indexCount: number) => {
  pooled.pos.needsUpdate = true;
  pooled.nrm.needsUpdate = true;
  pooled.col.needsUpdate = true;
  pooled.root.needsUpdate = true;
  pooled.index.needsUpdate = true;
  pooled.geometry.setDrawRange(0, indexCount);
  pooled.mesh.visible = indexCount > 0;
};

// ── The system ────────────────────────────────────────────────────────────────────────────────────

export function createVegetation(options: VegetationOptions): VegetationSystem {
  const { scene, useWebGPU, sampleHeight, samplePaint, isExcluded } = options;

  const grassTpl = buildGrassTemplate();
  const flowerTpl = buildFlowerTemplate();
  const rockTpl = buildRockTemplate();
  const treeTpls = buildTreeTemplates();

  // Shared uniform nodes — one set drives every sway material.
  const uPlayer = uniform(new THREE.Vector3(0, -100, 0));
  const uCamXZ = uniform(new THREE.Vector2(0, 0));
  const uFade = uniform(new THREE.Vector2(30, 42));
  const uWindDir = uniform(new THREE.Vector2(0.83, 0.55));

  const makeSwayMaterial = (windAmp: number, bend: boolean, fade: boolean): THREE.Material => {
    if (!useWebGPU) {
      return new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    }
    const material = new MeshLambertNodeMaterial();
    material.vertexColors = true;
    material.side = THREE.DoubleSide;
    const root = vec4(attribute("aVegRoot", "vec4"));
    const rootXZ = vec2(root.x, root.y);
    const phase = root.z;
    const swayW = root.w;
    // Per-blade flutter modulated by a slow gust front traveling along the wind direction.
    const gust = sin(time.mul(0.55).add(dot(rootXZ, uWindDir).mul(0.09))).mul(0.5).add(0.5);
    const flutter = sin(time.mul(1.9).add(phase))
      .mul(0.6)
      .add(sin(time.mul(3.7).add(phase.mul(1.7))).mul(0.25));
    const amp = float(windAmp).mul(gust.mul(0.85).add(0.25)).mul(swayW);
    let offset = vec3(uWindDir.x, 0, uWindDir.y).mul(flutter.mul(amp));
    if (bend) {
      // Bend away from the player's feet — the walking-through-grass feel.
      const toVert = rootXZ.sub(vec2(uPlayer.x, uPlayer.z));
      const dist = length(toVert);
      const press = smoothstep(1.9, 0.3, dist).mul(swayW).mul(0.85);
      const dir = toVert.div(max(dist, 0.001));
      offset = offset.add(vec3(dir.x, press.mul(-0.22), dir.y).mul(press));
    }
    let position = vec3(positionLocal);
    if (fade) {
      // Distance fade: shrink tufts toward their root instead of alpha-fading (no sorting artifacts).
      const d = length(rootXZ.sub(uCamXZ));
      const f = smoothstep(uFade.y, uFade.x, d);
      position = vec3(
        positionLocal.x.sub(root.x).mul(f).add(root.x),
        positionLocal.y.mul(f.mul(0.85).add(0.15)),
        positionLocal.z.sub(root.y).mul(f).add(root.y),
      );
      offset = offset.mul(f);
    }
    material.positionNode = position.add(offset);
    return material;
  };

  const grassMaterial = makeSwayMaterial(0.16, true, true);
  const treeMaterial = makeSwayMaterial(0.05, false, false);
  const rockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

  const group = new THREE.Group();
  group.name = "tellus-vegetation";
  scene.add(group);

  const chunkVertCap = MAX_TUFTS * (grassTpl.pos.length / 3) + MAX_FLOWERS * (flowerTpl.pos.length / 3);
  const chunkIdxCap = MAX_TUFTS * grassTpl.idx.length + MAX_FLOWERS * flowerTpl.idx.length;

  const makePooled = (vertCap: number, idxCap: number, material: THREE.Material): PooledMesh => {
    const geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(vertCap * 3), 3);
    const nrm = new THREE.BufferAttribute(new Float32Array(vertCap * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(vertCap * 3), 3);
    const root = new THREE.BufferAttribute(new Float32Array(vertCap * 4), 4);
    const index = new THREE.BufferAttribute(new Uint32Array(idxCap), 1);
    for (const a of [pos, nrm, col, root, index]) a.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", pos);
    geometry.setAttribute("normal", nrm);
    geometry.setAttribute("color", col);
    geometry.setAttribute("aVegRoot", root);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.visible = false;
    group.add(mesh);
    return { mesh, geometry, pos, nrm, col, root, index };
  };

  const freePool: PooledMesh[] = [];
  const acquirePooled = (): PooledMesh => freePool.pop() ?? makePooled(chunkVertCap, chunkIdxCap, grassMaterial);
  const releasePooled = (p: PooledMesh) => {
    p.mesh.visible = false;
    p.geometry.setDrawRange(0, 0);
    freePool.push(p);
  };

  const active = new Map<string, ActiveChunk>();
  let terrainRev = 1;
  let tier = useWebGPU ? 3 : 1;
  let tierGoodSince = 0;
  let lastDiffAt = 0;
  let lastDiffX = Infinity;
  let lastDiffZ = Infinity;
  const rebuildQueue: string[] = [];
  const queued = new Set<string>();
  let disposed = false;

  const slopeAt = (x: number, z: number, h: number) => {
    const dx = sampleHeight(x + 0.9, z) - h;
    const dz = sampleHeight(x, z + 0.9) - h;
    return Math.sqrt(dx * dx + dz * dz) / 0.9;
  };

  const tintColor = new THREE.Color();

  const buildChunk = (chunk: ActiveChunk) => {
    const { cx, cz, pooled } = chunk;
    const ox = cx * CHUNK - HALF_WORLD;
    const oz = cz * CHUNK - HALF_WORLD;
    const rng = mulberry32(cellSeed(cx, cz, 0x5eed));
    const cur: StampCursor = { v: 0, i: 0 };
    const tierCap = Math.round(MAX_TUFTS * TIERS[tier].density);
    let placed = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    const edge2 = (WORLD_RADIUS - 1.2) * (WORLD_RADIUS - 1.2);
    for (let i = 0; i < TUFT_CANDIDATES && placed < tierCap; i++) {
      const x = ox + rng() * CHUNK;
      const z = oz + rng() * CHUNK;
      const roll = rng();
      const sJit = rng();
      const yawJit = rng();
      const tintJit = rng();
      const phaseJit = rng();
      if (x * x + z * z > edge2) continue;
      const h = sampleHeight(x, z);
      if (h < SEA_LEVEL + 0.45) continue;
      if (isExcluded(x, z, h)) continue;
      const style = GRASS_BY_PAINT[samplePaint(x, z) ?? "meadow"] ?? GRASS_BY_PAINT.meadow;
      if (roll > style.accept) continue;
      if (slopeAt(x, z, h) > 1.15) continue;
      tintColor.setHex(style.tint);
      tintColor.offsetHSL((tintJit - 0.5) * 0.045, (tintJit - 0.5) * 0.1, (sJit - 0.5) * 0.07);
      const scale = (0.55 + sJit * 0.45) * style.tall;
      if (!stampTemplate(pooled, cur, grassTpl, x, h - 0.02, z, scale, yawJit * Math.PI * 2, tintColor, phaseJit * Math.PI * 2, 1)) break;
      placed++;
      if (h < minY) minY = h;
      if (h + scale > maxY) maxY = h + scale;
    }
    for (let i = 0; i < MAX_FLOWERS * 2; i++) {
      const x = ox + rng() * CHUNK;
      const z = oz + rng() * CHUNK;
      const roll = rng();
      const pick = rng();
      const yawJit = rng();
      if (x * x + z * z > edge2) continue;
      const paint = samplePaint(x, z);
      const accept = paint === "flowers" ? 0.5 : paint === "meadow" || paint === null ? 0.055 : 0;
      if (roll > accept * TIERS[tier].density) continue;
      const h = sampleHeight(x, z);
      if (h < SEA_LEVEL + 0.45 || isExcluded(x, z, h) || slopeAt(x, z, h) > 0.9) continue;
      tintColor.setHex(FLOWER_PALETTE[Math.floor(pick * FLOWER_PALETTE.length) % FLOWER_PALETTE.length]);
      if (!stampTemplate(pooled, cur, flowerTpl, x, h - 0.02, z, 0.62 + pick * 0.5, yawJit * Math.PI * 2, tintColor, pick * Math.PI * 2, 0.8)) break;
      if (h < minY) minY = h;
      if (h + 1 > maxY) maxY = h + 1;
    }
    markPooledUpdated(pooled, cur.i);
    if (cur.i > 0) {
      if (!Number.isFinite(minY)) {
        minY = 0;
        maxY = 1;
      }
      let sphere = pooled.geometry.boundingSphere;
      if (!sphere) {
        sphere = new THREE.Sphere();
        pooled.geometry.boundingSphere = sphere;
      }
      sphere.center.set(ox + CHUNK / 2, (minY + maxY) / 2, oz + CHUNK / 2);
      sphere.radius = Math.hypot(CHUNK * 0.75, (maxY - minY) / 2 + 1.5) + 1;
    }
    chunk.rev = terrainRev;
    chunk.tier = tier;
  };

  // ── island-wide trees + rocks (one merged mesh each; rebuilt only on terrain change) ──
  const maxTreeVerts = Math.max(treeTpls.conifer.pos.length, treeTpls.broadleaf.pos.length) / 3;
  const maxTreeIdx = Math.max(treeTpls.conifer.idx.length, treeTpls.broadleaf.idx.length);
  const treePooled = makePooled(260 * maxTreeVerts, 260 * maxTreeIdx, treeMaterial);
  treePooled.mesh.castShadow = true;
  treePooled.mesh.frustumCulled = false;
  const rockPooled = makePooled(220 * (rockTpl.pos.length / 3), 220 * rockTpl.idx.length, rockMaterial);
  rockPooled.mesh.castShadow = true;
  rockPooled.mesh.frustumCulled = false;
  let treeColliders: TreeCollider[] = [];
  let treeCount = 0;
  let globalsRev = 0;

  const rebuildGlobals = () => {
    const cur: StampCursor = { v: 0, i: 0 };
    const colliders: TreeCollider[] = [];
    treeCount = 0;
    const treeEdge2 = (WORLD_RADIUS - 3) * (WORLD_RADIUS - 3);
    for (let gx = -HALF_WORLD + 3; gx < HALF_WORLD - 3; gx += 7) {
      for (let gz = -HALF_WORLD + 3; gz < HALF_WORLD - 3; gz += 7) {
        const rng = mulberry32(cellSeed(Math.round(gx * 3), Math.round(gz * 3), 0x7ee5));
        const x = gx + rng() * 5.6;
        const z = gz + rng() * 5.6;
        if (x * x + z * z > treeEdge2) continue;
        const h = sampleHeight(x, z);
        if (h < SEA_LEVEL + 0.6) continue;
        if (isExcluded(x, z, h)) continue;
        if (slopeAt(x, z, h) > 0.62) continue;
        const paint = samplePaint(x, z);
        const accept =
          paint === "meadow" || paint === null
            ? 0.34
            : paint === "dirt"
              ? 0.24
              : paint === "flowers"
                ? 0.12
                : paint === "rock"
                  ? 0.1
                  : paint === "snow"
                    ? 0.14
                    : 0.04;
        if (rng() > accept) continue;
        const conifer = h > 8.5 || paint === "rock" || paint === "snow" || rng() < 0.3;
        const tpl = conifer ? treeTpls.conifer : treeTpls.broadleaf;
        const scale = conifer ? 4.2 + rng() * 2.6 : 3.4 + rng() * 1.8;
        tintColor.setHex(0xffffff);
        tintColor.offsetHSL((rng() - 0.5) * 0.05, (rng() - 0.5) * 0.18, (rng() - 0.5) * 0.1);
        if (!stampTemplate(treePooled, cur, tpl, x, h - 0.06, z, scale, rng() * Math.PI * 2, tintColor, rng() * Math.PI * 2, 1)) continue;
        colliders.push({ x, z, r: Math.max(0.42, scale * 0.085) });
        treeCount++;
      }
    }
    markPooledUpdated(treePooled, cur.i);
    treeColliders = colliders;

    const rcur: StampCursor = { v: 0, i: 0 };
    const rockEdge2 = (WORLD_RADIUS - 2) * (WORLD_RADIUS - 2);
    for (let gx = -HALF_WORLD + 2; gx < HALF_WORLD - 2; gx += 5.5) {
      for (let gz = -HALF_WORLD + 2; gz < HALF_WORLD - 2; gz += 5.5) {
        const rng = mulberry32(cellSeed(Math.round(gx * 5), Math.round(gz * 5), 0x9bb1));
        const x = gx + rng() * 4.4;
        const z = gz + rng() * 4.4;
        if (x * x + z * z > rockEdge2) continue;
        const h = sampleHeight(x, z);
        if (h < SEA_LEVEL + 0.3) continue;
        if (isExcluded(x, z, h)) continue;
        const paint = samplePaint(x, z);
        const accept =
          paint === "rock" ? 0.5 : paint === "dirt" ? 0.2 : paint === "beach" ? 0.16 : paint === "snow" ? 0.18 : 0.06;
        if (rng() > accept) continue;
        tintColor.setHex(paint === "snow" ? 0xc9cdd4 : 0x8d8a84);
        tintColor.offsetHSL(0, 0, (rng() - 0.5) * 0.14);
        const scale = 0.16 + rng() * rng() * 0.55;
        if (!stampTemplate(rockPooled, rcur, rockTpl, x, h + scale * 0.32, z, scale, rng() * Math.PI * 2, tintColor, 0, 0)) continue;
      }
    }
    markPooledUpdated(rockPooled, rcur.i);
    globalsRev = terrainRev;
  };

  // ── streaming + adaptive tier ──
  const chunkKey = (cx: number, cz: number) => `${cx}:${cz}`;
  const enqueueRebuild = (key: string) => {
    if (!queued.has(key)) {
      queued.add(key);
      rebuildQueue.push(key);
    }
  };

  const diffChunks = (px: number, pz: number) => {
    const radius = TIERS[tier].radius;
    const reach = radius + CHUNK * 0.71;
    const minCx = Math.max(0, Math.floor((px - reach + HALF_WORLD) / CHUNK));
    const maxCx = Math.min(GRID - 1, Math.floor((px + reach + HALF_WORLD) / CHUNK));
    const minCz = Math.max(0, Math.floor((pz - reach + HALF_WORLD) / CHUNK));
    const maxCz = Math.min(GRID - 1, Math.floor((pz + reach + HALF_WORLD) / CHUNK));
    const wanted = new Set<string>();
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const dx = cx * CHUNK - HALF_WORLD + CHUNK / 2 - px;
        const dz = cz * CHUNK - HALF_WORLD + CHUNK / 2 - pz;
        if (dx * dx + dz * dz > reach * reach) continue;
        const key = chunkKey(cx, cz);
        wanted.add(key);
        if (!active.has(key)) {
          active.set(key, { key, cx, cz, pooled: acquirePooled(), rev: 0, tier: -1 });
          enqueueRebuild(key);
        }
      }
    }
    for (const [key, chunk] of active) {
      if (!wanted.has(key)) {
        releasePooled(chunk.pooled);
        active.delete(key);
        queued.delete(key);
      }
    }
  };

  const update = (px: number, pz: number, playerY: number, fps: number, nowMs: number) => {
    if (disposed) return;
    uPlayer.value.set(px, playerY, pz);
    uCamXZ.value.set(px, pz);
    uFade.value.set(TIERS[tier].radius * 0.7, TIERS[tier].radius);

    // Adaptive tier: drop fast under load, climb back only after sustained headroom.
    if (fps > 0) {
      const maxTier = useWebGPU ? 3 : 2;
      if (fps < 38 && tier > 0) {
        tier--;
        tierGoodSince = 0;
      } else if (fps > 56 && tier < maxTier) {
        if (tierGoodSince === 0) tierGoodSince = nowMs;
        else if (nowMs - tierGoodSince > 4000) {
          tier++;
          tierGoodSince = 0;
        }
      } else {
        tierGoodSince = 0;
      }
    }

    if (globalsRev !== terrainRev) rebuildGlobals();

    const moved = Math.hypot(px - lastDiffX, pz - lastDiffZ);
    if (nowMs - lastDiffAt > 250 && (moved > 3 || nowMs - lastDiffAt > 1500)) {
      lastDiffAt = nowMs;
      lastDiffX = px;
      lastDiffZ = pz;
      diffChunks(px, pz);
    }

    let budget = fps > 0 && fps < 45 ? 1 : 2;
    while (budget > 0 && rebuildQueue.length > 0) {
      const key = rebuildQueue.shift()!;
      queued.delete(key);
      const chunk = active.get(key);
      if (!chunk) continue;
      if (chunk.rev === terrainRev && chunk.tier === tier) continue;
      buildChunk(chunk);
      budget--;
    }
    if (rebuildQueue.length === 0) {
      for (const chunk of active.values()) {
        if (chunk.rev !== terrainRev || chunk.tier !== tier) enqueueRebuild(chunk.key);
      }
    }
  };

  return {
    update,
    notifyTerrainChanged: () => {
      terrainRev++;
    },
    getTreeColliders: () => treeColliders,
    stats: () => {
      let indices = 0;
      for (const chunk of active.values()) indices += chunk.pooled.geometry.drawRange.count;
      return { tier, chunks: active.size, grassIndices: indices, trees: treeCount };
    },
    dispose: () => {
      disposed = true;
      for (const chunk of active.values()) chunk.pooled.geometry.dispose();
      active.clear();
      for (const p of freePool) p.geometry.dispose();
      freePool.length = 0;
      treePooled.geometry.dispose();
      rockPooled.geometry.dispose();
      scene.remove(group);
      grassMaterial.dispose();
      treeMaterial.dispose();
      rockMaterial.dispose();
    },
  };
}
