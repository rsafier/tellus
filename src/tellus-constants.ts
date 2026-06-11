import * as THREE from "three";

import type {
  GenerationProvider,
  InstantMeshTarget,
  TerrainKind,
  TerrainPaintKind,
  Vec3,
} from "./tellus-types";

// ── World scale ──────────────────────────────────────────────────────────────────────────────────
// Worlds can be BIGGER than the classic island. The scale derives from the world's NAME (a pure
// convention, so every client — and the Hyades server's bit-faithful terrain port — agrees with no
// protocol change): `large-*`/`big-*`/`xl-*` → 3×, `mega-*`/`giant-*` → 5×. The 97×97 terrain grid is
// kept and STRETCHED over the bigger radius (coarser sculpt resolution per metre, identical sync
// payloads), and the terrain feature math runs in "classic space" (coords ÷ scale) so the base island
// shapes scale up with the world. setWorldScale() must run BEFORE the world is created/loaded; size
// constants below are exported as `let` so ES-module live bindings propagate updated values.
export const CLASSIC_WORLD_RADIUS = 72;
export let WORLD_SCALE = 1;
export let WORLD_RADIUS = 72;
export let OCEAN_RADIUS = 240;
export let CENTRAL_WALK_RADIUS = WORLD_RADIUS - 0.5;
export let POND_RADIUS = 7.4;
export const POND_CENTER: Vec3 = { x: 18, y: 0, z: -12 };

export function worldScaleForId(worldId: string): number {
  const id = worldId.toLowerCase();
  if (/^(mega|giant)[-_]/.test(id)) return 5;
  if (/^(large|big|xl)[-_]/.test(id)) return 3;
  return 1;
}

export function setWorldScale(scale: number): void {
  WORLD_SCALE = scale;
  WORLD_RADIUS = CLASSIC_WORLD_RADIUS * scale;
  OCEAN_RADIUS = 240 * scale;
  CENTRAL_WALK_RADIUS = WORLD_RADIUS - 0.5;
  POND_RADIUS = 7.4 * scale;
  POND_CENTER.x = 18 * scale;
  POND_CENTER.z = -12 * scale;
}

/** Walk speed grows on big worlds so traversal stays fun (1× → 13, 3× → ~24.7, 5× → ~36.4). */
export function scaledPlayerSpeed(): number {
  return PLAYER_SPEED * (1 + (WORLD_SCALE - 1) * 0.45);
}

export const SEA_LEVEL = -3.35;
export const DISTANT_ISLAND_COUNT = 18;
export const TERRAIN_SEGMENTS = 96;
export const DISTANT_TERRAIN_SEGMENTS = 32;
export const DISTANT_TERRAIN_VERTEX_COUNT = DISTANT_TERRAIN_SEGMENTS + 1;
export const DISTANT_WALK_LOCAL_RADIUS = 1.02;
export const PLAYER_SPEED = 13;
export const PENDING_GENERATION_FALLBACK_MS = 3 * 60 * 1000;
export const TERRAIN_VERTEX_COUNT = TERRAIN_SEGMENTS + 1;
export const TERRAIN_SCULPT_RADIUS = 6.2;
export const TERRAIN_SCULPT_STEP = 0.72;
export const SKYBOX_FALLBACK_URLS = [
  "/skybox/free_-_skybox_in_the_cloud/scene.gltf",
  "/skybox/free_-_skybox_in_the_cloud.glb",
  "/skybox/skybox_skydays_3.glb",
  "/skybox/free_-_skybox_basic_sky.glb",
];
export const SKYBOX_VERTICAL_OFFSET = 0;
export const DEFAULT_DAY_NIGHT_CYCLE_MS = 10 * 60 * 1000;
export const DEFAULT_DAY_NIGHT_START = 0.18;
export const MIN_DAY_NIGHT_CYCLE_MS = 60_000;
export const MOON_MODEL_URL = "/moon/moon.glb";
export const MOON_DISTANCE = 124;
export const MOON_SIZE = 26;
export const MOON_ARC_AZIMUTH = 0.54;
export const MOON_ARC_LATERAL_SWAY = 0.58;

export const PIXEL3D_PROVIDER = "pixel3d-gradio";

export const generationProviderLabels: Record<GenerationProvider, string> = {
  local: "Local placeholder",
  "asset-forge": "Pixel3D legacy",
  "instantmesh-gradio": "Fast asset",
  "pixal3d-gradio": "High quality",
  "anigen-gradio": "Animated",
};
export const instantMeshTargetLabels: Record<InstantMeshTarget, string> = {
  dgx: "DGX",
  local: "Local",
};
export const terrainColors: Record<TerrainKind, THREE.Color> = {
  meadow: new THREE.Color(0x5fa22e),
  rock: new THREE.Color(0x6f7467),
  snow: new THREE.Color(0xd4e7e2),
  beach: new THREE.Color(0xf6dcbd),
  dirt: new THREE.Color(0x8a7241),
  flowers: new THREE.Color(0x6daa35),
  water: new THREE.Color(0x256f92),
};

export const terrainPaintKinds = [
  "meadow",
  "beach",
  "dirt",
  "rock",
  "snow",
  "flowers",
] as const satisfies readonly TerrainPaintKind[];

export const waterMountTerms = [
  "dolphin",
  "orca",
  "whale",
  "sea turtle",
  "giant turtle",
  "hippocampus",
  "seahorse mount",
];

export const airMountTerms = [
  "giant eagle",
  "eagle",
  "griffin",
  "gryphon",
  "dragon",
  "wyvern",
  "pegasus",
  "roc",
  "flying mount",
];

export const groundMountTerms = [
  "horse",
  "pony",
  "stag",
  "elk",
  "camel",
  "llama",
  "giant wolf",
  "mount",
  "rideable",
];

