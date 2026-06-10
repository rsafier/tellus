import * as THREE from "three";

import type {
  GenerationProvider,
  InstantMeshTarget,
  TerrainKind,
  TerrainPaintKind,
  Vec3,
} from "./tellus-types";

export const WORLD_RADIUS = 72;
export const OCEAN_RADIUS = 240;
export const SEA_LEVEL = -3.35;
export const DISTANT_ISLAND_COUNT = 18;
export const TERRAIN_SEGMENTS = 96;
export const DISTANT_TERRAIN_SEGMENTS = 32;
export const DISTANT_TERRAIN_VERTEX_COUNT = DISTANT_TERRAIN_SEGMENTS + 1;
export const CENTRAL_WALK_RADIUS = WORLD_RADIUS - 0.5;
export const DISTANT_WALK_LOCAL_RADIUS = 1.02;
export const AGENT_SPEED = 5.2;
export const PLAYER_SPEED = 13;
export const AUTONOMOUS_ASSET_INTERVAL_MS = 60_000;
export const AUTONOMOUS_REFLECTION_OFFSET_MS = AUTONOMOUS_ASSET_INTERVAL_MS / 2;
export const AUTONOMOUS_AGENT_GENERATION_ENABLED = false;
export const PENDING_GENERATION_FALLBACK_MS = 3 * 60 * 1000;
export const POND_CENTER: Vec3 = { x: 18, y: 0, z: -12 };
export const POND_RADIUS = 7.4;
export const TERRAIN_VERTEX_COUNT = TERRAIN_SEGMENTS + 1;
export const TERRAIN_SCULPT_RADIUS = 6.2;
export const TERRAIN_SCULPT_STEP = 0.72;
export const WORLD_FEEDBACK_INTERVAL_MS = 75_000;
export const WORLD_FEEDBACK_START_DELAY_MS = 14_000;
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
export const allAgentIds = ["johnny", "mira", "sol", "atlas"] as const;

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

export const johnnyFallbackIdeas = [
  "a sunlit footbridge made of pale cedar crossing a small stream",
  "a tiny workshop hut with mossy shingles and brass tools outside",
  "a gentle stone creature curled beside a patch of blue flowers",
  "a hot air balloon moored beside a garden path",
  "a clear pond with lilies, stepping stones, and a little wooden dock",
  "a spiral lantern tower that glows softly near the mountain",
  "a weathered sailboat with a folded cream canvas sail",
  "a copper rain collector shaped like a broad leaf",
  "a carved stone waygate with glowing moss in its grooves",
  "a tiny apiary box painted yellow beside wildflowers",
  "a driftwood fishing pier with rope-wrapped posts",
  "a round observatory hut with a brass telescope on top",
  "a blue ceramic fountain shaped like a moon shell",
  "a small windmill pump with white wooden blades",
  "a low stone bridge with fern-filled cracks",
  "a mossy outdoor workbench covered with clay pots",
  "a floating lantern buoy tethered to a wooden stake",
  "a red berry tree with a hollow doorway in its trunk",
  "a tiny clay kiln with stacked firewood beside it",
  "a curved boardwalk segment made from dark wet planks",
  "a one-seat glider with leaf-shaped green wings",
  "a crystal marker obelisk set into a grassy mound",
  "a striped canvas market awning on two cedar poles",
  "a little stone well with a wooden crank and bucket",
];
