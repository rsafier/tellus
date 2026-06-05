import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Box,
  Compass,
  Leaf,
  MessageCircle,
  Mic,
  Mountain,
  Pause,
  Play,
  Send,
  Ship,
  Sparkles,
  Wand2,
} from "lucide-react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshBasicNodeMaterial, WebGPURenderer } from "three/webgpu";
import {
  color,
  linearDepth,
  mx_worley_noise_float,
  positionWorld,
  screenUV,
  time,
  vec2,
  viewportDepthTexture,
  viewportLinearDepth,
  viewportSharedTexture,
} from "three/tsl";
import "./styles.css";

type AgentId = "johnny" | "mira" | "sol" | "atlas";

type TerrainKind = "meadow" | "rock" | "snow" | "beach" | "dirt" | "water";
type GeneratedKind =
  | "tree"
  | "flower"
  | "stone"
  | "animal"
  | "path"
  | "shrine"
  | "seed"
  | "balloon"
  | "object";

type ToolName = "generate" | "interact";

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface TellusAgent {
  id: AgentId;
  name: string;
  epithet: string;
  color: number;
  goal: string;
  avatarUrl?: string;
  position: Vec3;
  target: Vec3;
  nextActionAt: number;
  nextReflectionAt: number;
}

interface GeneratedThing {
  id: string;
  kind: GeneratedKind;
  prompt: string;
  creatorId: AgentId | "visitor";
  position: Vec3;
  scale: number;
  color: number;
  modelUrl?: string;
  pipelineId?: string;
  generationStatus?: "local" | "queued" | "generating" | "ready" | "failed";
}

interface TellusLog {
  id: string;
  tick: number;
  agentId: AgentId | "visitor" | "world";
  agentName: string;
  tool: ToolName;
  text: string;
}

interface GenerateRequest {
  prompt: string;
  location: Vec3 | "near-agent" | "near-mountain" | "near-pond";
  scale?: number;
  creatorId: AgentId | "visitor";
}

interface InteractRequest {
  targetId: string;
  intent: string;
  actorId: AgentId | "visitor";
}

interface TellusSnapshot {
  agents: TellusAgent[];
  generated: GeneratedThing[];
  logs: TellusLog[];
  paused: boolean;
  selectedThingId?: string;
  sailingThingId?: string;
}

interface TellusWorldApi {
  generate(request: GenerateRequest): GeneratedThing;
  interact(request: InteractRequest): TellusLog;
  selectGenerated(id?: string): void;
  moveGenerated(id: string, dx: number, dz: number): void;
  moveGeneratedToWater(id: string): void;
  boardGenerated(id: string): void;
  disembark(): void;
  talkToAgent(agentId: AgentId, message: string): void;
  setPaused(paused: boolean): void;
  submitVisitorPrompt(prompt: string): void;
  snapshot(): TellusSnapshot;
  destroy(): void;
}

interface TellusRuntimeConfig {
  assetForgeApiBase: string;
  agentModel: string;
  generationProvider: "local" | "asset-forge" | "instantmesh-gradio";
  skyboxUrl: string;
  enabledAgents: AgentId[];
  avatars: Partial<Record<AgentId, string>>;
}

interface AgentDecision {
  prompt: string;
  intent?: string;
  speech?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
}

interface AssetForgePipelineStart {
  pipelineId: string;
  status: string;
  message: string;
}

interface AssetForgePipelineStatus {
  id: string;
  status: "initializing" | "processing" | "completed" | "failed" | string;
  progress: number;
  finalAsset?: {
    modelUrl?: string;
  };
  error?: string;
}

interface DirectGenerationResponse {
  jobId: string;
  modelUrl: string;
  provider: string;
  rawModelUrl?: string;
  storedModelUrl?: string;
  storedModelPath?: string;
  sourceImageUrl?: string;
  sourceImagePath?: string;
  textImageProvider?: string;
  manifestUrl?: string;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    __tellusRoot?: ReturnType<typeof createRoot>;
  }
}

const WORLD_RADIUS = 42;
const OCEAN_RADIUS = 170;
const SEA_LEVEL = -1.55;
const DISTANT_ISLAND_COUNT = 18;
const TERRAIN_SEGMENTS = 96;
const AGENT_SPEED = 5.2;
const PLAYER_SPEED = 13;
const AUTONOMOUS_ASSET_INTERVAL_MS = 60_000;
const AUTONOMOUS_REFLECTION_OFFSET_MS = AUTONOMOUS_ASSET_INTERVAL_MS / 2;
const POND_CENTER: Vec3 = { x: 18, y: 0, z: -12 };
const POND_RADIUS = 7.4;
const PIXEL3D_PROVIDER = "pixel3d-gradio";
const runtimeConfig: TellusRuntimeConfig = {
  assetForgeApiBase:
    import.meta.env.VITE_ASSET_FORGE_API_BASE?.replace(/\/+$/, "") ?? "",
  agentModel:
    import.meta.env.VITE_TELLUS_AGENT_MODEL ??
    "GLM-5.1",
  generationProvider:
    (import.meta.env.VITE_TELLUS_GENERATION_PROVIDER as
      | TellusRuntimeConfig["generationProvider"]
      | undefined) ?? "local",
  skyboxUrl: import.meta.env.VITE_TELLUS_SKYBOX_URL ?? "",
  enabledAgents: ["johnny"],
  avatars: {
    johnny: import.meta.env.VITE_TELLUS_JOHNNY_AVATAR_URL,
    mira: import.meta.env.VITE_TELLUS_MIRA_AVATAR_URL,
    sol: import.meta.env.VITE_TELLUS_SOL_AVATAR_URL,
  },
};
const gltfObjectCache = new Map<string, Promise<THREE.Object3D>>();
const allAgentIds = ["johnny", "mira", "sol", "atlas"] as const;

type MaterialWithTextureMaps = THREE.Material & {
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
};

const terrainColors: Record<TerrainKind, THREE.Color> = {
  meadow: new THREE.Color(0x5fa22e),
  rock: new THREE.Color(0x5f7074),
  snow: new THREE.Color(0xd4e7e2),
  beach: new THREE.Color(0xf6dcbd),
  dirt: new THREE.Color(0x8a7241),
  water: new THREE.Color(0x256f92),
};

function createAgentSeeds(): TellusAgent[] {
  const seeds: TellusAgent[] = [
    {
      id: "johnny",
      name: "Johnny",
      epithet: "world-forger",
      color: 0x7ec850,
      goal: "Freely imagine and generate any useful 3D asset for Tellus: terrain features, plants, animals, buildings, tools, vehicles, paths, water features, landmarks, habitats, companions, or strange beautiful objects.",
      avatarUrl: runtimeConfig.avatars.johnny,
      position: { x: -15, y: 0, z: 11 },
      target: { x: -11, y: 0, z: 9 },
      nextActionAt: 0,
      nextReflectionAt: 0,
    },
    {
      id: "mira",
      name: "Mira",
      epithet: "animal-lover",
      color: 0xe8b86d,
      goal: "Create creatures, animals, birds, fish, and reptiles each with a corresponding habitat, make homes for creatures great and small.",
      avatarUrl: runtimeConfig.avatars.mira,
      position: { x: 18, y: 0, z: 6 },
      target: { x: 13, y: 0, z: 4 },
      nextActionAt: 800,
      nextReflectionAt: 0,
    },
    {
      id: "sol",
      name: "Sol",
      epithet: "",
      color: 0x98a7ff,
      goal: "Build housing, shrines, and holy places in special spots that pay homage to nature.",
      avatarUrl: runtimeConfig.avatars.sol,
      position: { x: -5, y: 0, z: -21 },
      target: { x: -3, y: 0, z: -17 },
      nextActionAt: 1600,
      nextReflectionAt: 0,
    },
     {
      id: "atlas",
      name: "atlas",
      epithet: "",
      color: 0x98a7ff,
      goal: "Build roads, bridges, paths, trails, to connect the islands together, and create boats, hot air balloons, horses, waterways, streams, rivers, ponds, lagoons, wells, waterfalls and aquaducts.",
      avatarUrl: runtimeConfig.avatars.sol,
      position: { x: -5, y: 0, z: -21 },
      target: { x: -3, y: 0, z: -17 },
      nextActionAt: 2400,
      nextReflectionAt: 0,
    },
  ];
  const enabled = new Set(runtimeConfig.enabledAgents);
  return seeds.filter((agent) => enabled.has(agent.id));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rand(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function distance2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalizedDiscPosition(x: number, z: number): Vec3 {
  const radius = Math.hypot(x, z);
  if (radius <= WORLD_RADIUS - 2) {
    return { x, y: terrainHeight(x, z), z };
  }
  const scale = (WORLD_RADIUS - 2) / radius;
  const nx = x * scale;
  const nz = z * scale;
  return { x: nx, y: terrainHeight(nx, nz), z: nz };
}

function oceanPosition(x: number, z: number): Vec3 {
  const radius = Math.hypot(x, z);
  const maxRadius = OCEAN_RADIUS - 12;
  if (radius <= maxRadius) return { x, y: SEA_LEVEL + 0.14, z };
  const scale = maxRadius / radius;
  return { x: x * scale, y: SEA_LEVEL + 0.14, z: z * scale };
}

type VehicleMode = "water" | "air" | "ground";

function vehicleMode(thing: GeneratedThing): VehicleMode | null {
  const lower = thing.prompt.toLowerCase();
  if (
    thing.kind === "balloon" ||
    lower.includes("balloon") ||
    lower.includes("airship") ||
    lower.includes("zeppelin") ||
    lower.includes("glider") ||
    lower.includes("flying") ||
    lower.includes("air boat")
  ) {
    return "air";
  }
  if (
    lower.includes("boat") ||
    lower.includes("ship") ||
    lower.includes("sail") ||
    lower.includes("canoe") ||
    lower.includes("raft") ||
    lower.includes("skiff") ||
    lower.includes("dinghy")
  ) {
    return "water";
  }
  if (
    lower.includes("vehicle") ||
    lower.includes("cart") ||
    lower.includes("wagon") ||
    lower.includes("carriage") ||
    lower.includes("car ") ||
    lower.includes("truck") ||
    lower.includes("horse")
  ) {
    return "ground";
  }
  return null;
}

function isVehicleThing(thing: GeneratedThing): boolean {
  return vehicleMode(thing) !== null;
}

function isFreeMovingVehicle(thing: GeneratedThing): boolean {
  const mode = vehicleMode(thing);
  return mode === "water" || mode === "air";
}

function airPosition(x: number, z: number): Vec3 {
  const radius = Math.hypot(x, z);
  const maxRadius = OCEAN_RADIUS - 14;
  const scale = radius > maxRadius ? maxRadius / radius : 1;
  const nx = x * scale;
  const nz = z * scale;
  const groundY =
    Math.hypot(nx, nz) <= WORLD_RADIUS
      ? terrainHeight(nx, nz)
      : SEA_LEVEL;
  return { x: nx, y: groundY + 12, z: nz };
}

function movedVehiclePosition(thing: GeneratedThing, x: number, z: number): Vec3 {
  const mode = vehicleMode(thing);
  if (mode === "air") return airPosition(x, z);
  if (mode === "water") return oceanPosition(x, z);
  return normalizedDiscPosition(x, z);
}

function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const mountain = Math.max(0, 1 - r / 20);
  const mound = Math.pow(mountain, 2.2) * 21;
  const shoulder = Math.exp(-((x + 16) ** 2 + (z - 12) ** 2) / 190) * 4.2;
  const southernRise = Math.exp(-((x - 9) ** 2 + (z + 24) ** 2) / 160) * 3.1;
  const ridge =
    Math.sin(x * 0.22 + z * 0.08) * 1.05 +
    Math.cos(z * 0.2 - x * 0.06) * 0.72 +
    Math.sin((x + z) * 0.11) * 0.42;
  const rimDrop = Math.max(0, (r - 30) / 12) * 5.8;
  const pond = Math.exp(-((x - 18) ** 2 + (z + 12) ** 2) / 65) * 2.5;
  return mound + shoulder + southernRise + ridge - rimDrop - pond - 0.65;
}

function terrainKind(x: number, z: number, y: number): TerrainKind {
  const pondDistance = Math.hypot(x - 18, z + 12);
  if (pondDistance < 7 && y < 1.9) return "water";
  if (y > 13.5) return "snow";
  if (y > 6.8) return "rock";
  const pathBand = Math.abs(Math.sin(Math.atan2(z, x) * 3 + 0.5)) < 0.13;
  if (pathBand && Math.hypot(x, z) > 8) return "dirt";
  return "meadow";
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyRuntimeConfig(config: unknown): void {
  if (!isRecord(config)) return;

  const assetForgeApiBase = config.assetForgeApiBase;
  if (
    !import.meta.env.VITE_ASSET_FORGE_API_BASE?.trim() &&
    typeof assetForgeApiBase === "string" &&
    assetForgeApiBase.trim()
  ) {
    runtimeConfig.assetForgeApiBase = assetForgeApiBase.trim().replace(/\/+$/, "");
  }

  const agentModel = config.agentModel;
  if (
    !import.meta.env.VITE_TELLUS_AGENT_MODEL?.trim() &&
    typeof agentModel === "string" &&
    agentModel.trim()
  ) {
    runtimeConfig.agentModel = agentModel.trim();
  }

  const generationProvider = config.generationProvider;
  if (
    !import.meta.env.VITE_TELLUS_GENERATION_PROVIDER?.trim() &&
    (generationProvider === "local" ||
      generationProvider === "asset-forge" ||
      generationProvider === "instantmesh-gradio")
  ) {
    runtimeConfig.generationProvider = generationProvider;
  }

  const skyboxUrl = config.skyboxUrl;
  if (typeof skyboxUrl === "string" && skyboxUrl.trim()) {
    runtimeConfig.skyboxUrl = skyboxUrl.trim();
  }

  const enabledAgents = config.enabledAgents;
  if (Array.isArray(enabledAgents)) {
    const configuredAgentIds = enabledAgents.filter(
      (agentId): agentId is AgentId =>
        typeof agentId === "string" &&
        allAgentIds.includes(agentId as AgentId),
    );
    if (configuredAgentIds.length > 0) {
      runtimeConfig.enabledAgents = [...new Set(configuredAgentIds)];
    }
  }

  const avatars = config.avatars;
  if (!isRecord(avatars)) return;

  for (const agentId of allAgentIds) {
    const avatarUrl = avatars[agentId];
    if (typeof avatarUrl === "string" && avatarUrl.trim()) {
      runtimeConfig.avatars[agentId] = avatarUrl.trim();
    }
  }
}

async function loadRuntimeConfigFile(path: string): Promise<void> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 404) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  applyRuntimeConfig(await readJsonResponse<unknown>(response));
}

async function loadRuntimeConfig(): Promise<void> {
  await loadRuntimeConfigFile("/tellus-config.json");
  await loadRuntimeConfigFile("/tellus-config.local.json");
}

function toAssetId(prompt: string, prefix: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `tellus-${prefix}-${slug || "creation"}-${Date.now().toString(36)}`;
}

function absoluteAssetForgeUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${runtimeConfig.assetForgeApiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    const message = extractErrorMessage(body);
    throw new Error(`${response.status}${message ? ` ${message}` : ""}`);
  }
  return (await response.json()) as T;
}

function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") {
      return sanitizeLogText(parsed.error);
    }
  } catch {
    // Fall through to text cleanup.
  }
  return sanitizeLogText(body);
}

function sanitizeLogText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function startPixel3DGeneration(
  thing: GeneratedThing,
  signal?: AbortSignal,
): Promise<AssetForgePipelineStart> {
  if (!runtimeConfig.assetForgeApiBase) {
    throw new Error("VITE_ASSET_FORGE_API_BASE is not configured");
  }

  const assetId = toAssetId(thing.prompt, thing.kind);
  const response = await fetch(`${runtimeConfig.assetForgeApiBase}/api/generation/pipeline`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assetId,
      name: thing.prompt.slice(0, 72),
      description: thing.prompt,
      type: thing.kind === "animal" ? "character" : "environment",
      subtype: thing.kind,
      generationType: thing.kind === "animal" ? "avatar" : "model",
      quality: "standard",
      enableRigging: thing.kind === "animal",
      enableRetexturing: false,
      enableSprites: false,
      customPrompts: {
        gameStyle:
          "A tropical island paradise WebGPU floating-world, assets for Tellus should be on white background with only one object each, stylized, game-ready low-poly proportions.",
      },
      metadata: {
        provider: PIXEL3D_PROVIDER,
        useGPT5Enhancement: false,
      },
    }),
  });

  return readJsonResponse<AssetForgePipelineStart>(response);
}

async function waitForPixel3DModelUrl(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise((resolve) => window.setTimeout(resolve, 4000));
    signal?.throwIfAborted();
    const response = await fetch(
      `${runtimeConfig.assetForgeApiBase}/api/generation/pipeline/${pipelineId}`,
      { signal },
    );
    const status = await readJsonResponse<AssetForgePipelineStatus>(response);
    if (status.status === "failed") {
      throw new Error(status.error ?? `Pipeline ${pipelineId} failed`);
    }
    if (status.status === "completed" && status.finalAsset?.modelUrl) {
      return absoluteAssetForgeUrl(status.finalAsset.modelUrl);
    }
  }
  throw new Error(`Pipeline ${pipelineId} timed out`);
}

function hasExternalGenerationProvider(): boolean {
  if (runtimeConfig.generationProvider === "asset-forge") {
    return Boolean(runtimeConfig.assetForgeApiBase);
  }
  return runtimeConfig.generationProvider === "instantmesh-gradio";
}

async function startDirectInstantMeshGeneration(
  thing: GeneratedThing,
  signal?: AbortSignal,
): Promise<DirectGenerationResponse> {
  const response = await fetch("/api/generate-3d", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: thing.id,
      prompt: thing.prompt,
      kind: thing.kind,
    }),
  });
  return readJsonResponse<DirectGenerationResponse>(response);
}

function createTerrainGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let z = 0; z <= TERRAIN_SEGMENTS; z++) {
    const vz = (z / TERRAIN_SEGMENTS - 0.5) * WORLD_RADIUS * 2;
    for (let x = 0; x <= TERRAIN_SEGMENTS; x++) {
      const vx = (x / TERRAIN_SEGMENTS - 0.5) * WORLD_RADIUS * 2;
      const r = Math.hypot(vx, vz);
      const inside = r <= WORLD_RADIUS;
      const edgeScale = inside ? 1 : WORLD_RADIUS / r;
      const px = vx * edgeScale;
      const pz = vz * edgeScale;
      const py = inside ? terrainHeight(px, pz) : -4.5;
      const kind = inside ? terrainKind(px, pz, py) : "rock";
      const color = terrainColors[kind].clone();
      const noise = 0.9 + rand(x * 1009 + z * 9176) * 0.18;
      color.multiplyScalar(noise);
      positions.push(px, py, pz);
      colors.push(color.r, color.g, color.b);
    }
  }

  const row = TERRAIN_SEGMENTS + 1;
  for (let z = 0; z < TERRAIN_SEGMENTS; z++) {
    for (let x = 0; x < TERRAIN_SEGMENTS; x++) {
      const a = z * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createFloatingRim(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(
    WORLD_RADIUS,
    WORLD_RADIUS * 0.82,
    9,
    128,
    1,
    true,
  );
  geometry.translate(0, -6.5, 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0x6a5b48,
    roughness: 0.9,
    metalness: 0,
  });
  return new THREE.Mesh(geometry, material);
}

function createOceanSurface(): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(OCEAN_RADIUS, 192);
  const material = new THREE.MeshStandardMaterial({
    color: 0x234f72,
    emissive: 0x173d58,
    emissiveIntensity: 0.16,
    roughness: 0.42,
    metalness: 0,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ocean = new THREE.Mesh(geometry, material);
  ocean.name = "tellus-surrounding-ocean";
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = SEA_LEVEL;
  ocean.renderOrder = -4;
  return ocean;
}

function createDistantIsland(
  seed: number,
  angle: number,
  radius: number,
  size = 1,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `tellus-distant-island-${seed}`;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  group.position.set(x, SEA_LEVEL - 0.02, z);

  const islandColor = new THREE.Color(0x4f8b2e).lerp(
    new THREE.Color(0x243d35),
    rand(seed + 4) * 0.45,
  );
  const islandHeight = 1.2 + rand(seed + 3) * 0.9;
  const island = new THREE.Mesh(
    new THREE.CylinderGeometry(
      (4.6 + rand(seed + 1) * 4) * size,
      (8.5 + rand(seed + 2) * 7) * size,
      islandHeight,
      18,
      1,
    ),
    new THREE.MeshStandardMaterial({
      color: islandColor,
      roughness: 0.94,
      metalness: 0,
    }),
  );
  island.position.y = islandHeight * 0.42;
  island.scale.z = 0.55 + rand(seed + 5) * 0.65;
  island.rotation.y = rand(seed + 6) * Math.PI;
  group.add(island);

  const spireCount = 2 + Math.floor(rand(seed + 7) * (size > 1.5 ? 7 : 5));
  for (let i = 0; i < spireCount; i++) {
    const spireHeight = (5 + rand(seed + i * 17) * 12) * (0.8 + size * 0.2);
    const spire = new THREE.Mesh(
      new THREE.ConeGeometry(
        (0.7 + rand(seed + i * 13) * 1.8) * (0.9 + size * 0.18),
        spireHeight,
        10,
      ),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x7a6a4a).lerp(new THREE.Color(0x2c3b48), rand(seed + i)),
        roughness: 0.88,
      }),
    );
    const localAngle = rand(seed + i * 19) * Math.PI * 2;
    const localRadius = (1.4 + rand(seed + i * 23) * 6) * size;
    spire.position.set(
      Math.cos(localAngle) * localRadius,
      2.4 + spireHeight * 0.42,
      Math.sin(localAngle) * localRadius * island.scale.z,
    );
    spire.rotation.z = (rand(seed + i * 29) - 0.5) * 0.22;
    group.add(spire);
  }

  return group;
}

function createDistantArchipelago(): THREE.Group {
  const group = new THREE.Group();
  group.name = "tellus-distant-archipelago";
  for (let i = 0; i < DISTANT_ISLAND_COUNT; i++) {
    const angle =
      (i / DISTANT_ISLAND_COUNT) * Math.PI * 2 + rand(900 + i) * 0.32;
    const radius = 58 + rand(1400 + i) * 72;
    const isDestinationIsland = i % 5 === 1 || i % 7 === 4;
    const size = isDestinationIsland
      ? 2.05 + rand(2500 + i) * 0.85
      : 0.9 + rand(2600 + i) * 0.42;
    group.add(createDistantIsland(1800 + i * 43, angle, radius, size));
  }
  return group;
}

function createSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(220, 48, 24);
  const material = new THREE.MeshBasicMaterial({
    color: 0xa9c8f2,
    side: THREE.BackSide,
  });
  return new THREE.Mesh(geometry, material);
}

function createBackdropWaterMaterial(): MeshBasicNodeMaterial {
  const t = time.mul(0.72);
  const waterUV = positionWorld.xzy;
  const broadFlow = mx_worley_noise_float(waterUV.mul(0.55).add(t.mul(0.16)));
  const surfaceFlow = mx_worley_noise_float(
    waterUV.mul(3.9).add(broadFlow.mul(0.42)).add(t),
  );
  const fineRipples = mx_worley_noise_float(
    waterUV.mul(10.5).add(surfaceFlow.mul(0.35)).add(t.mul(1.7)),
  );
  const surfaceIntensity = surfaceFlow.mul(fineRipples).mul(1.65);
  const waterColor = surfaceIntensity.mix(color(0x0c7199), color(0xc7fbff));
  const illuminatedColor = waterColor.add(
    color(0x8ff6ff).mul(surfaceIntensity.mul(0.28)),
  );

  const depth = linearDepth();
  const depthWater = viewportLinearDepth.sub(depth);
  const depthEffect = depthWater.remapClamp(-0.002, 0.065);
  const refractionUV = screenUV.add(
    vec2(
      broadFlow.sub(0.5).mul(0.018),
      surfaceIntensity.sub(0.5).mul(0.074),
    ),
  );
  const depthTestForRefraction = linearDepth(
    viewportDepthTexture(refractionUV),
  ).sub(depth);
  const depthRefraction = depthTestForRefraction.remapClamp(0, 0.16);
  const finalUV = depthTestForRefraction.lessThan(0).select(screenUV, refractionUV);
  const viewportTexture = viewportSharedTexture(finalUV);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = illuminatedColor;
  material.backdropNode = depthEffect.mix(
    viewportSharedTexture(),
    viewportTexture.mul(depthRefraction.mix(1, illuminatedColor)),
  );
  material.backdropAlphaNode = depthRefraction.oneMinus().mul(0.9);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  return material;
}

function createWaterDistortionVeil(): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(POND_RADIUS * 0.92, 128);
  const material = new THREE.MeshBasicMaterial({
    color: 0xd8fbff,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const veil = new THREE.Mesh(geometry, material);
  veil.name = "tellus-water-distortion-veil";
  return veil;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    for (const item of material) item.dispose();
    return;
  }
  material.dispose();
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    disposeMaterial(child.material);
  });
}

function fitModelToHeight(model: THREE.Object3D, targetHeight: number): THREE.Object3D {
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? targetHeight / size.y : 1;
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  model.traverse((child) => {
    child.frustumCulled = false;
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return model;
}

function placeObjectAboveGround(
  object: THREE.Object3D,
  position: Vec3,
  clearance = 0.04,
): void {
  object.position.set(position.x, position.y, position.z);
  const bounds = new THREE.Box3().setFromObject(object);
  if (!Number.isFinite(bounds.min.y)) return;
  object.position.y += position.y - bounds.min.y + clearance;
}

async function loadGltfObject(url: string): Promise<THREE.Object3D> {
  const cached =
    gltfObjectCache.get(url) ??
    new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene);
  gltfObjectCache.set(url, cached);
  return (await cached).clone(true);
}

function prepareSkyboxModel(model: THREE.Object3D): THREE.Object3D {
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const largestAxis = Math.max(size.x, size.y, size.z);
  const scale = largestAxis > 0 ? 520 / largestAxis : 1;

  model.name = "tellus-external-skybox";
  model.position.sub(center);
  model.scale.setScalar(scale);
  model.renderOrder = -100;

  model.traverse((child) => {
    child.frustumCulled = false;
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const skyMaterials = materials.map((material) => {
      const mappedMaterial = material as MaterialWithTextureMaps;
      const map = mappedMaterial.map ?? mappedMaterial.emissiveMap ?? null;
      const skyMaterial = new THREE.MeshBasicMaterial({
        map,
        color: map ? 0xffffff : 0xaac8f2,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      });
      material.side = THREE.DoubleSide;
      material.depthWrite = false;
      return skyMaterial;
    });
    child.material = Array.isArray(child.material) ? skyMaterials : skyMaterials[0];
  });

  return model;
}

async function loadSkyboxModel(): Promise<THREE.Object3D | null> {
  if (!runtimeConfig.skyboxUrl) return null;
  const response = await fetch(runtimeConfig.skyboxUrl, { method: "HEAD" });
  if (!response.ok) return null;
  return prepareSkyboxModel(await loadGltfObject(runtimeConfig.skyboxUrl));
}

async function loadAgentAvatar(agent: TellusAgent): Promise<THREE.Object3D | null> {
  if (!agent.avatarUrl) return null;
  const avatar = await loadGltfObject(agent.avatarUrl);
  avatar.name = `avatar-${agent.id}`;
  return fitModelToHeight(avatar, 2.45);
}

async function loadGeneratedModel(url: string, thing: GeneratedThing): Promise<THREE.Object3D> {
  const model = await loadGltfObject(url);
  model.name = `pixel3d-${thing.id}`;
  const fitted = fitModelToHeight(model, clamp(thing.scale * 2.25, 1.2, 4.2));
  fitted.userData = { ...fitted.userData, tellusId: thing.id, kind: thing.kind };
  if (isFreeMovingVehicle(thing)) {
    fitted.position.set(thing.position.x, thing.position.y, thing.position.z);
  } else {
    placeObjectAboveGround(fitted, thing.position, 0.08);
  }
  return fitted;
}

function createPondWater(): THREE.Group {
  const group = new THREE.Group();
  group.name = "tellus-pond-water";
  group.userData = { waterSurface: true };

  const waterLevel = terrainHeight(POND_CENTER.x, POND_CENTER.z) + 0.55;
  const waterMaterial = createBackdropWaterMaterial();
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(POND_RADIUS, 96),
    waterMaterial,
  );
  water.name = "tellus-pond-surface";
  water.rotation.x = -Math.PI / 2;
  water.position.set(POND_CENTER.x, waterLevel, POND_CENTER.z);
  water.renderOrder = 2;

  const rippleMaterial = new THREE.MeshBasicMaterial({
    color: 0xd3f2ff,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const rippleGeometry = new THREE.RingGeometry(0.88, 0.93, 96);
  const ripples = new THREE.Group();
  ripples.name = "tellus-pond-ripples";
  ripples.position.set(POND_CENTER.x, waterLevel + 0.035, POND_CENTER.z);
  ripples.rotation.x = -Math.PI / 2;

  for (let i = 0; i < 4; i++) {
    const ripple = new THREE.Mesh(rippleGeometry, rippleMaterial.clone());
    const scale = POND_RADIUS * (0.28 + i * 0.18);
    ripple.scale.setScalar(scale);
    ripple.userData = { rippleIndex: i };
    ripples.add(ripple);
  }

  const shore = new THREE.Mesh(
    new THREE.RingGeometry(POND_RADIUS * 0.96, POND_RADIUS * 1.08, 128),
    new THREE.MeshStandardMaterial({
      color: 0x7b6b48,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  shore.name = "tellus-pond-shore";
  shore.rotation.x = -Math.PI / 2;
  shore.position.set(POND_CENTER.x, waterLevel - 0.035, POND_CENTER.z);

  const veil = createWaterDistortionVeil();
  veil.rotation.x = -Math.PI / 2;
  veil.position.set(POND_CENTER.x, waterLevel + 0.055, POND_CENTER.z);
  veil.renderOrder = 3;

  group.add(shore, water, veil, ripples);
  return group;
}

function createCloud(seed: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    transparent: true,
    opacity: 0.55,
  });
  const count = 4 + Math.floor(rand(seed) * 4);
  for (let i = 0; i < count; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(2.5 + rand(seed + i) * 2, 12, 8),
      material,
    );
    puff.scale.y = 0.35;
    puff.position.set(
      (i - count / 2) * 2.5,
      rand(seed + i * 7) * 1.3,
      rand(seed + i * 13) * 2,
    );
    group.add(puff);
  }
  const angle = rand(seed * 2) * Math.PI * 2;
  const radius = 55 + rand(seed * 3) * 55;
  group.position.set(
    Math.cos(angle) * radius,
    34 + rand(seed * 4) * 18,
    Math.sin(angle) * radius,
  );
  return group;
}

function createAgentMesh(agent: TellusAgent): THREE.Group {
  const group = new THREE.Group();
  group.name = `agent-${agent.id}`;
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: agent.color,
    roughness: 0.72,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x182018,
    roughness: 0.8,
  });
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.55, 1.25, 6, 12),
    bodyMaterial,
  );
  body.position.y = 1.15;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 16, 12),
    bodyMaterial,
  );
  head.position.y = 2.25;
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.7, 0.035, 8, 32),
    darkMaterial,
  );
  halo.position.y = 2.8;
  halo.rotation.x = Math.PI / 2;
  group.add(body, head, halo);
  return group;
}

function createVisitorMesh(): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xf0d39a,
    roughness: 0.68,
  });
  const robeMaterial = new THREE.MeshStandardMaterial({
    color: 0x2f5947,
    roughness: 0.8,
  });
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 1.2, 6, 12),
    robeMaterial,
  );
  body.position.y = 1.1;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.43, 16, 12),
    bodyMaterial,
  );
  head.position.y = 2.15;
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.5, 16),
    bodyMaterial,
  );
  marker.position.set(0, 2.72, 0);
  group.add(body, head, marker);
  return group;
}

function inferGeneratedKind(
  prompt: string,
  agentId: AgentId | "visitor",
): GeneratedKind {
  const lower = prompt.toLowerCase();
  if (
    lower.includes("creature") ||
    lower.includes("companion") ||
    lower.includes("beast") ||
    lower.includes("critter") ||
    lower.includes("animal") ||
    lower.includes("fox") ||
    lower.includes("bird") ||
    lower.includes("horse") ||
    lower.includes("fish") ||
    lower.includes("reptile")
  )
    return "animal";
  if (
    lower.includes("hut") ||
    lower.includes("house") ||
    lower.includes("workshop") ||
    lower.includes("building") ||
    lower.includes("cottage") ||
    lower.includes("cabin") ||
    lower.includes("tower") ||
    lower.includes("lantern") ||
    lower.includes("bridge") ||
    lower.includes("dock") ||
    lower.includes("boat") ||
    lower.includes("tool") ||
    lower.includes("vehicle") ||
    lower.includes("statue") ||
    lower.includes("object") ||
    lower.includes("prop")
  )
    return "object";
  if (
    lower.includes("tree") ||
    lower.includes("apple") ||
    lower.includes("forest") ||
    lower.includes("sapling")
  )
    return "tree";
  if (
    lower.includes("balloon") ||
    lower.includes("airship") ||
    lower.includes("zeppelin")
  )
    return "balloon";
  if (lower.includes("flower") || lower.includes("moss")) return "flower";
  if (
    lower.includes("stone") ||
    lower.includes("rock") ||
    lower.includes("cairn")
  )
    return "stone";
  if (lower.includes("path") || lower.includes("trail")) return "path";
  if (lower.includes("shrine") || lower.includes("altar")) return "shrine";
  if (lower.includes("seed")) return "seed";
  if (agentId === "sol") return rand(Date.now()) > 0.55 ? "stone" : "shrine";
  if (agentId === "mira") return rand(Date.now()) > 0.5 ? "animal" : "flower";
  return "object";
}

function promptAccent(prompt: string): number {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    hash = (hash * 31 + prompt.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  const color = new THREE.Color().setHSL(hue / 360, 0.55, 0.58);
  return color.getHex();
}

function kindColor(kind: GeneratedKind, prompt: string): number {
  if (kind === "tree")
    return prompt.toLowerCase().includes("apple") ? 0x68a845 : 0x4f8f3a;
  if (kind === "flower") return 0xe7a0cf;
  if (kind === "stone") return 0x9b9b90;
  if (kind === "animal") return 0xb9824b;
  if (kind === "path") return 0x9a7447;
  if (kind === "shrine") return 0x7d83b5;
  if (kind === "balloon") return 0xf0a65f;
  if (kind === "object") return promptAccent(prompt);
  return 0xd3c17a;
}

function createGeneratedMesh(thing: GeneratedThing): THREE.Object3D {
  const material = new THREE.MeshStandardMaterial({
    color: thing.color,
    roughness: 0.85,
    metalness: 0,
  });
  const group = new THREE.Group();
  group.name = thing.id;
  group.userData = { tellusId: thing.id, kind: thing.kind };

  if (thing.kind === "tree") {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.22, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x6d4a2d }),
    );
    trunk.position.y = 0.8 * thing.scale;
    trunk.scale.multiplyScalar(thing.scale);
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 14, 10),
      material,
    );
    crown.position.y = 1.95 * thing.scale;
    crown.scale.setScalar(thing.scale);
    const fruit = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xb9352d }),
    );
    fruit.position.set(
      0.35 * thing.scale,
      2.1 * thing.scale,
      0.32 * thing.scale,
    );
    group.add(trunk, crown, fruit);
  } else if (thing.kind === "flower") {
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.035, 0.55, 6),
      new THREE.MeshStandardMaterial({ color: 0x407a35 }),
    );
    stem.position.y = 0.28;
    const bloom = new THREE.Mesh(
      new THREE.SphereGeometry(0.18 * thing.scale, 10, 8),
      material,
    );
    bloom.position.y = 0.62;
    group.add(stem, bloom);
  } else if (thing.kind === "animal") {
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 12, 8),
      material,
    );
    body.scale.set(1.5, 0.75, 0.8);
    body.position.y = 0.5;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 10, 8),
      material,
    );
    head.position.set(0.62, 0.58, 0);
    group.add(body, head);
  } else if (thing.kind === "path") {
    const path = new THREE.Mesh(
      new THREE.CylinderGeometry(
        1.2 * thing.scale,
        1.2 * thing.scale,
        0.05,
        18,
      ),
      material,
    );
    path.scale.z = 0.45;
    path.position.y = 0.03;
    group.add(path);
  } else if (thing.kind === "shrine") {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 0.9, 0.35, 6),
      material,
    );
    base.position.y = 0.18;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 6), material);
    top.position.y = 0.9;
    group.add(base, top);
  } else if (thing.kind === "balloon") {
    const envelope = new THREE.Mesh(
      new THREE.SphereGeometry(0.72 * thing.scale, 24, 16),
      material,
    );
    envelope.scale.set(0.9, 1.18, 0.9);
    envelope.position.y = 2.05 * thing.scale;

    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.52 * thing.scale, 0.035 * thing.scale, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0xffe2a8, roughness: 0.7 }),
    );
    band.rotation.x = Math.PI / 2;
    band.position.y = 2.02 * thing.scale;

    const basket = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.48 * thing.scale,
        0.34 * thing.scale,
        0.42 * thing.scale,
      ),
      new THREE.MeshStandardMaterial({ color: 0x8b5c35, roughness: 0.9 }),
    );
    basket.position.y = 0.72 * thing.scale;

    const ropeMaterial = new THREE.MeshStandardMaterial({
      color: 0x4c3b2a,
      roughness: 0.8,
    });
    const ropeOffsets = [
      [-0.26, -0.2],
      [0.26, -0.2],
      [-0.26, 0.2],
      [0.26, 0.2],
    ] as const;
    for (const [x, z] of ropeOffsets) {
      const rope = new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.012 * thing.scale,
          0.012 * thing.scale,
          1.08 * thing.scale,
          6,
        ),
        ropeMaterial,
      );
      rope.position.set(x * thing.scale, 1.2 * thing.scale, z * thing.scale);
      group.add(rope);
    }

    group.add(envelope, band, basket);
  } else if (thing.kind === "object") {
    const hash = Array.from(thing.prompt).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    );
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: promptAccent(`${thing.prompt}:accent`),
      roughness: 0.72,
      metalness: 0.03,
    });
    const base =
      hash % 3 === 0
        ? new THREE.Mesh(
            new THREE.BoxGeometry(
              0.78 * thing.scale,
              0.5 * thing.scale,
              0.78 * thing.scale,
            ),
            material,
          )
        : hash % 3 === 1
          ? new THREE.Mesh(
              new THREE.IcosahedronGeometry(0.48 * thing.scale, 1),
              material,
            )
          : new THREE.Mesh(
              new THREE.CylinderGeometry(
                0.46 * thing.scale,
                0.58 * thing.scale,
                0.62 * thing.scale,
                7,
              ),
              material,
            );
    base.position.y = 0.36 * thing.scale;

    const crown =
      hash % 2 === 0
        ? new THREE.Mesh(
            new THREE.ConeGeometry(0.4 * thing.scale, 0.8 * thing.scale, 7),
            accentMaterial,
          )
        : new THREE.Mesh(
            new THREE.SphereGeometry(0.32 * thing.scale, 12, 8),
            accentMaterial,
          );
    crown.position.y = 0.98 * thing.scale;

    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.48 * thing.scale, 0.025 * thing.scale, 8, 28),
      new THREE.MeshStandardMaterial({
        color: 0xf7ead1,
        roughness: 0.55,
        metalness: 0.02,
      }),
    );
    marker.rotation.x = Math.PI / 2;
    marker.position.y = 0.18 * thing.scale;

    group.add(base, crown, marker);
  } else {
    const seed = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.35 * thing.scale, 1),
      material,
    );
    seed.position.y = 0.32;
    group.add(seed);
  }

  if (isFreeMovingVehicle(thing) || Math.hypot(thing.position.x, thing.position.z) > WORLD_RADIUS) {
    group.position.set(thing.position.x, thing.position.y, thing.position.z);
  } else {
    placeObjectAboveGround(group, thing.position, 0.025);
  }
  return group;
}

function createGenerationSwirl(thing: GeneratedThing): THREE.Object3D {
  const group = new THREE.Group();
  group.name = thing.id;
  group.userData = { tellusId: thing.id, kind: thing.kind, generatingSwirl: true };

  const primary = new THREE.Color(thing.color);
  const light = primary.clone().lerp(new THREE.Color(0xffffff), 0.58);
  const material = new THREE.MeshBasicMaterial({
    color: light,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const ringGeometry = new THREE.TorusGeometry(0.52, 0.018, 8, 56);
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(ringGeometry, material.clone());
    ring.userData = { swirlRing: i };
    ring.rotation.x = Math.PI / 2 + i * 0.62;
    ring.rotation.y = i * 0.48;
    ring.position.y = 0.55 + i * 0.22;
    ring.scale.setScalar(0.72 + i * 0.18);
    group.add(ring);
  }

  const sparkMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparkGeometry = new THREE.SphereGeometry(0.045, 8, 6);
  for (let i = 0; i < 7; i++) {
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial.clone());
    const angle = (i / 7) * Math.PI * 2;
    spark.userData = { swirlSpark: i, baseAngle: angle };
    spark.position.set(Math.cos(angle) * 0.56, 0.72 + i * 0.09, Math.sin(angle) * 0.56);
    group.add(spark);
  }

  group.position.set(thing.position.x, thing.position.y + 0.08, thing.position.z);
  group.userData.baseY = group.position.y;
  return group;
}

const johnnyFallbackIdeas = [
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

function normalizeAssetPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(
      /\b(a|an|the|with|and|of|made|from|for|near|beside|next|to|little|tiny|small)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function promptAlreadyExists(prompt: string, generated: GeneratedThing[]): boolean {
  const normalized = normalizeAssetPrompt(prompt);
  if (!normalized) return false;
  return generated.some((thing) => normalizeAssetPrompt(thing.prompt) === normalized);
}

function chooseAgentPrompt(
  agent: TellusAgent,
  generated: GeneratedThing[],
): string {
  if (agent.id === "johnny") {
    const start = generated.length % johnnyFallbackIdeas.length;
    for (let i = 0; i < johnnyFallbackIdeas.length; i++) {
      const idea = johnnyFallbackIdeas[(start + i) % johnnyFallbackIdeas.length];
      if (!promptAlreadyExists(idea, generated)) return idea;
    }
    return `a unique carved island relic number ${generated.length + 1} with a distinct silhouette`;
  }
  if (agent.id === "mira") {
    return generated.length % 2 === 0
      ? "a curious amber fox nosing around the meadow"
      : "a patch of blue flowers where animals can rest";
  }
  return generated.length % 2 === 0
    ? "a hand-placed stone cairn that points toward the summit"
    : "a narrow dirt path spiraling gently toward the mountain";
}

function ensureNovelAgentDecision(
  decision: AgentDecision,
  agent: TellusAgent,
  generated: GeneratedThing[],
): AgentDecision {
  const prompt = decision.prompt.trim();
  if (!promptAlreadyExists(prompt, generated)) {
    return { ...decision, prompt };
  }
  const replacementPrompt = chooseAgentPrompt(agent, generated);
  return {
    ...decision,
    prompt: replacementPrompt,
    intent:
      decision.intent ??
      "study what should live near here next and how this new asset changes the world",
    speech:
      decision.speech ??
      "I will add something different so this place keeps unfolding.",
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

function parseAgentDecision(content: string, fallbackPrompt: string): AgentDecision {
  const parsed = extractJsonObject(content);
  if (isRecord(parsed)) {
    const prompt = parsed.prompt;
    const intent = parsed.intent;
    const speech = parsed.speech;
    return {
      prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : fallbackPrompt,
      intent: typeof intent === "string" && intent.trim() ? intent.trim() : undefined,
      speech: typeof speech === "string" && speech.trim() ? speech.trim() : undefined,
    };
  }
  return { prompt: content.trim() || fallbackPrompt };
}

function chooseAgentLocation(
  agent: TellusAgent,
  prompt: string,
): GenerateRequest["location"] {
  const lower = prompt.toLowerCase();
  if (
    lower.includes("mountain") ||
    lower.includes("summit") ||
    lower.includes("tower") ||
    lower.includes("shrine") ||
    lower.includes("cairn")
  ) {
    return "near-mountain";
  }
  if (
    lower.includes("pond") ||
    lower.includes("water") ||
    lower.includes("stream") ||
    lower.includes("river") ||
    lower.includes("dock") ||
    lower.includes("boat") ||
    lower.includes("lily") ||
    lower.includes("fish")
  ) {
    return "near-pond";
  }
  if (agent.id === "sol") return "near-mountain";
  if (agent.id === "mira") return "near-pond";
  return "near-agent";
}

function chatContent(completion: ChatCompletionResponse): string {
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

async function askAgentForDecision(
  agent: TellusAgent,
  generated: GeneratedThing[],
  logs: TellusLog[],
): Promise<AgentDecision> {
  const fallbackPrompt = chooseAgentPrompt(agent, generated);
  const recentObjects = generated
    .slice(-12)
    .map((thing) => `${thing.kind}: ${thing.prompt}`)
    .join("\n");
  const forbiddenPrompts = generated
    .slice(-24)
    .map((thing) => `- ${thing.prompt}`)
    .join("\n");
  const recentLogs = logs
    .slice(-8)
    .map((log) => `${log.agentName}: ${log.text}`)
    .join("\n");

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: runtimeConfig.agentModel,
      temperature: 0.85,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You are an enabled autonomous AI inside Tellus, a tiny living WebGPU world. You may generate any visible 3D asset you want: an object, plant, animal, character, building, tool, vehicle, bridge, path segment, terrain feature, water feature, habitat prop, landmark, or other game-ready prop. Decide one concise thing to generate next. Return only JSON with keys prompt, intent, and speech. The prompt must describe exactly one single asset, not a scene, set, collection, habitat, landscape, or group of objects. Do not repeat or paraphrase any existing object. The speech should be one short in-character sentence said aloud before you act.",
        },
        {
          role: "user",
          content: [
            `Agent: ${agent.name}, ${agent.epithet}`,
            `Goal: ${agent.goal}`,
            `Current generated count: ${generated.length}`,
            `Recent objects:\n${recentObjects || "none yet"}`,
            `Do not generate these again, even as near synonyms:\n${forbiddenPrompts || "none yet"}`,
            `Recent logs:\n${recentLogs || "none yet"}`,
            `Fallback idea: ${fallbackPrompt}`,
          ].join("\n\n"),
        },
      ],
    }),
  });
  const completion = await readJsonResponse<ChatCompletionResponse>(response);
  const content = chatContent(completion);
  if (!content) return { prompt: fallbackPrompt };
  return ensureNovelAgentDecision(
    parseAgentDecision(content, fallbackPrompt),
    agent,
    generated,
  );
}

async function askAgentForReply(
  agent: TellusAgent,
  message: string,
  generated: GeneratedThing[],
  logs: TellusLog[],
): Promise<string> {
  const recentObjects = generated
    .slice(-10)
    .map((thing) => `${thing.kind}: ${thing.prompt}`)
    .join("\n");
  const recentLogs = logs
    .slice(-10)
    .map((log) => `${log.agentName}: ${log.text}`)
    .join("\n");
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: runtimeConfig.agentModel,
      temperature: 0.75,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content:
            "You are a living agent inside Tellus. Reply in character in one or two short sentences. Do not return JSON. Be concrete about what you see, want, or will do next.",
        },
        {
          role: "user",
          content: [
            `Agent: ${agent.name}, ${agent.epithet}`,
            `Goal: ${agent.goal}`,
            `Visitor says: ${message}`,
            `Recent objects:\n${recentObjects || "none yet"}`,
            `Recent logs:\n${recentLogs || "none yet"}`,
          ].join("\n\n"),
        },
      ],
    }),
  });
  const completion = await readJsonResponse<ChatCompletionResponse>(response);
  const content = chatContent(completion);
  return content || `${agent.name} listens, then turns back toward the world with a new idea.`;
}

function createTellusWorld(
  container: HTMLElement,
  onSnapshot: (snapshot: TellusSnapshot) => void,
): TellusWorldApi {
  let destroyed = false;
  let paused = false;
  let animationId = 0;
  let lastTime = performance.now();
  let tick = 0;
  let renderer: WebGPURenderer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let renderIssueLogged = false;

  const agents = createAgentSeeds().map((agent) => ({
    ...agent,
    position: { ...agent.position },
    target: { ...agent.target },
    nextActionAt: performance.now() + AUTONOMOUS_ASSET_INTERVAL_MS,
    nextReflectionAt: performance.now() + AUTONOMOUS_REFLECTION_OFFSET_MS,
  }));
  const generated: GeneratedThing[] = [];
  const logs: TellusLog[] = [];
  const generatedMeshes = new Map<string, THREE.Object3D>();
  const agentMeshes = new Map<AgentId, THREE.Group>();
  const pendingAgentDecisions = new Set<AgentId>();
  const pendingGenerationControllers = new Map<string, AbortController>();
  const keys = new Set<string>();
  let selectedThingId: string | undefined;
  let sailingThingId: string | undefined;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa7c3ef);
  scene.fog = new THREE.Fog(0xa7c3ef, 72, 230);

  const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 720);
  const fallbackSky = createSkyDome();
  const ocean = createOceanSurface();
  const archipelago = createDistantArchipelago();
  const terrain = new THREE.Mesh(
    createTerrainGeometry(),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
    }),
  );
  terrain.receiveShadow = true;
  const pondWater = createPondWater();
  scene.add(
    fallbackSky,
    ocean,
    archipelago,
    terrain,
    pondWater,
    createFloatingRim(),
  );

  const sun = new THREE.DirectionalLight(0xffdfb7, 4.1);
  sun.position.set(-55, 58, 42);
  sun.castShadow = true;
  scene.add(sun, new THREE.HemisphereLight(0xb6ccff, 0x3d5332, 2.25));

  for (let i = 0; i < 14; i++) {
    scene.add(createCloud(100 + i * 19));
  }

  for (const agent of agents) {
    const mesh = createAgentMesh(agent);
    agentMeshes.set(agent.id, mesh);
    scene.add(mesh);
  }

  const visitor = createVisitorMesh();
  let visitorPosition = normalizedDiscPosition(-20, 20);
  scene.add(visitor);

  let yaw = 0.72;
  let pitch = -0.28;
  let zoom = 33;
  let isDragging = false;
  let pointerX = 0;
  let pointerY = 0;
  let pointerTravel = 0;
  const pointerNdc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();

  const snapshot = (): TellusSnapshot => ({
    agents: agents.map((agent) => ({
      ...agent,
      position: { ...agent.position },
      target: { ...agent.target },
    })),
    generated: generated.map((thing) => ({
      ...thing,
      position: { ...thing.position },
    })),
    logs: logs.slice(-80),
    paused,
    selectedThingId,
    sailingThingId,
  });

  const publish = () => onSnapshot(snapshot());

  const addLog = (entry: Omit<TellusLog, "id" | "tick">): TellusLog => {
    const log: TellusLog = {
      id: makeId("log"),
      tick,
      ...entry,
    };
    logs.push(log);
    if (logs.length > 120) logs.shift();
    publish();
    return log;
  };

  const abortPendingGeneration = () => {
    for (const controller of pendingGenerationControllers.values()) {
      controller.abort();
    }
    pendingGenerationControllers.clear();
  };

  const thingById = (id: string): GeneratedThing | undefined =>
    generated.find((thing) => thing.id === id);

  const updateThingMeshPosition = (thing: GeneratedThing) => {
    const mesh = generatedMeshes.get(thing.id);
    if (!mesh) return;
    if (
      mesh.userData.generatingSwirl ||
      isFreeMovingVehicle(thing) ||
      Math.hypot(thing.position.x, thing.position.z) > WORLD_RADIUS
    ) {
      mesh.position.set(thing.position.x, thing.position.y, thing.position.z);
      if (mesh.userData.generatingSwirl) {
        mesh.userData.baseY = mesh.position.y;
      }
      return;
    }
    placeObjectAboveGround(mesh, thing.position, 0.04);
  };

  const selectGenerated = (id?: string) => {
    selectedThingId = id && thingById(id) ? id : undefined;
    publish();
  };

  const moveGenerated = (id: string, dx: number, dz: number) => {
    const thing = thingById(id);
    if (!thing) return;
    const position =
      isVehicleThing(thing) || sailingThingId === id
        ? movedVehiclePosition(thing, thing.position.x + dx, thing.position.z + dz)
        : normalizedDiscPosition(thing.position.x + dx, thing.position.z + dz);
    thing.position = position;
    if (sailingThingId === id) {
      visitorPosition = { ...position };
    }
    updateThingMeshPosition(thing);
    publish();
  };

  const moveGeneratedToWater = (id: string) => {
    const thing = thingById(id);
    if (!thing) return;
    const mode = vehicleMode(thing);
    const angle = Math.atan2(visitorPosition.z, visitorPosition.x) || 0.2;
    const radius =
      mode === "air"
        ? Math.max(14, Math.hypot(thing.position.x, thing.position.z))
        : WORLD_RADIUS + 5;
    thing.position =
      mode === "air"
        ? airPosition(Math.cos(angle) * radius, Math.sin(angle) * radius)
        : mode === "water"
          ? oceanPosition(Math.cos(angle) * radius, Math.sin(angle) * radius)
          : normalizedDiscPosition(
              Math.cos(angle) * (WORLD_RADIUS - 4),
              Math.sin(angle) * (WORLD_RADIUS - 4),
            );
    updateThingMeshPosition(thing);
    publish();
  };

  const boardGenerated = (id: string) => {
    const thing = thingById(id);
    const mode = thing ? vehicleMode(thing) : null;
    if (!thing || !mode) return;
    sailingThingId = id;
    selectedThingId = id;
    if (mode === "water" && Math.hypot(thing.position.x, thing.position.z) < WORLD_RADIUS - 1) {
      moveGeneratedToWater(id);
    } else if (mode === "air") {
      thing.position = airPosition(thing.position.x, thing.position.z);
    }
    const boarded = thingById(id);
    if (boarded) {
      visitorPosition = { ...boarded.position };
      updateThingMeshPosition(boarded);
    }
    addLog({
      agentId: "visitor",
      agentName: "Visitor",
      tool: "interact",
      text: `boarded ${thing.kind}: ${thing.prompt}`,
    });
    publish();
  };

  const disembark = () => {
    if (!sailingThingId) return;
    const boat = thingById(sailingThingId);
    sailingThingId = undefined;
    if (boat) {
      const mode = vehicleMode(boat);
      const shoreDirection = new THREE.Vector3(boat.position.x, 0, boat.position.z);
      if (mode === "air") {
        visitorPosition = normalizedDiscPosition(boat.position.x, boat.position.z);
      } else if (shoreDirection.lengthSq() > 0.001) {
        shoreDirection.normalize();
        visitorPosition = normalizedDiscPosition(
          shoreDirection.x * (WORLD_RADIUS - 2),
          shoreDirection.z * (WORLD_RADIUS - 2),
        );
      }
    }
    addLog({
      agentId: "visitor",
      agentName: "Visitor",
      tool: "interact",
      text: "stepped back onto Tellus.",
    });
    publish();
  };

  const chooseLocation = (request: GenerateRequest): Vec3 => {
    if (typeof request.location === "object")
      return normalizedDiscPosition(request.location.x, request.location.z);
    if (request.location === "near-mountain") {
      const angle = rand(tick + generated.length) * Math.PI * 2;
      const radius = 8 + rand(tick + 3) * 13;
      return normalizedDiscPosition(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
      );
    }
    if (request.location === "near-pond")
      return normalizedDiscPosition(
        15 + rand(tick) * 8,
        -15 + rand(tick + 1) * 7,
      );
    const agent = agents.find((item) => item.id === request.creatorId);
    const origin = agent?.position ?? visitorPosition;
    const angle = rand(tick + generated.length * 17) * Math.PI * 2;
    const radius = 3 + rand(tick + 33) * 7;
    return normalizedDiscPosition(
      origin.x + Math.cos(angle) * radius,
      origin.z + Math.sin(angle) * radius,
    );
  };

  const generate = (request: GenerateRequest): GeneratedThing => {
    const kind = inferGeneratedKind(request.prompt, request.creatorId);
    const position = chooseLocation(request);
    const thing: GeneratedThing = {
      id: makeId(kind),
      kind,
      prompt: request.prompt,
      creatorId: request.creatorId,
      position,
      scale: request.scale ?? 0.75 + rand(tick + generated.length) * 0.8,
      color: kindColor(kind, request.prompt),
      generationStatus: hasExternalGenerationProvider() ? "queued" : "local",
    };
    generated.push(thing);
    const mesh = hasExternalGenerationProvider()
      ? createGenerationSwirl(thing)
      : createGeneratedMesh(thing);
    generatedMeshes.set(thing.id, mesh);
    scene.add(mesh);

    const actor = agents.find((agent) => agent.id === request.creatorId);
    addLog({
      agentId: request.creatorId,
      agentName: actor?.name ?? "Visitor",
      tool: "generate",
      text: `${actor?.name ?? "Visitor"} generated ${thing.kind}: ${request.prompt}`,
    });

    const showLocalFallbackMesh = () => {
      const oldMesh = generatedMeshes.get(thing.id);
      if (oldMesh) {
        scene.remove(oldMesh);
        disposeObject(oldMesh);
      }
      const fallbackMesh = createGeneratedMesh(thing);
      generatedMeshes.set(thing.id, fallbackMesh);
      scene.add(fallbackMesh);
    };

    if (
      runtimeConfig.generationProvider === "asset-forge" &&
      runtimeConfig.assetForgeApiBase
    ) {
      const generationController = new AbortController();
      pendingGenerationControllers.set(thing.id, generationController);
      addLog({
        agentId: "world",
        agentName: "Pixel3D",
        tool: "generate",
        text: `Sending ${thing.kind} to Pixel3D: "${thing.prompt}"`,
      });
      void startPixel3DGeneration(thing, generationController.signal)
        .then(async (pipeline) => {
          if (destroyed || paused) return;
          thing.pipelineId = pipeline.pipelineId;
          thing.generationStatus = "generating";
          addLog({
            agentId: "world",
            agentName: "Pixel3D",
            tool: "generate",
            text: `Queued ${thing.kind} model for "${thing.prompt}" (${pipeline.pipelineId})`,
          });
          const modelUrl = await waitForPixel3DModelUrl(
            pipeline.pipelineId,
            generationController.signal,
          );
          if (destroyed || paused) return;
          thing.modelUrl = modelUrl;
          addLog({
            agentId: "world",
            agentName: "Pixel3D",
            tool: "generate",
            text: `Pixel3D returned a model URL for ${thing.kind}; loading it into Tellus.`,
          });
          const model = await loadGeneratedModel(modelUrl, thing);
          if (destroyed || paused) {
            disposeObject(model);
            return;
          }
          thing.generationStatus = "ready";
          const oldMesh = generatedMeshes.get(thing.id);
          if (oldMesh) {
            scene.remove(oldMesh);
            disposeObject(oldMesh);
          }
          generatedMeshes.set(thing.id, model);
          scene.add(model);
          addLog({
            agentId: "world",
            agentName: "Pixel3D",
            tool: "interact",
            text: `Loaded Pixel3D GLB into the scene for ${thing.kind}: ${thing.prompt}`,
          });
          publish();
        })
        .catch((error) => {
          if (paused || generationController.signal.aborted) {
            thing.generationStatus = "local";
            showLocalFallbackMesh();
            publish();
            return;
          }
          thing.generationStatus = "failed";
          showLocalFallbackMesh();
          addLog({
            agentId: "world",
            agentName: "Pixel3D",
            tool: "interact",
            text: `Pixel3D generation fell back to local mesh: ${
              error instanceof Error ? sanitizeLogText(error.message) : "unknown error"
            }`,
          });
          publish();
        })
        .finally(() => {
          pendingGenerationControllers.delete(thing.id);
        });
    } else if (runtimeConfig.generationProvider === "instantmesh-gradio") {
      const generationController = new AbortController();
      pendingGenerationControllers.set(thing.id, generationController);
      addLog({
        agentId: "world",
        agentName: "InstantMesh",
        tool: "generate",
        text: `Sending ${thing.kind} to InstantMesh: "${thing.prompt}"`,
      });
      void startDirectInstantMeshGeneration(thing, generationController.signal)
        .then(async (result) => {
          if (destroyed || paused) return;
          thing.pipelineId = result.jobId;
          thing.modelUrl = result.modelUrl;
          addLog({
            agentId: "world",
            agentName: "InstantMesh",
            tool: "generate",
            text: `InstantMesh used ${result.textImageProvider ?? "image"} source ${result.sourceImageUrl ?? "image"} and saved ${thing.kind} GLB to ${result.storedModelUrl ?? result.modelUrl}; loading it into Tellus.`,
          });
          const model = await loadGeneratedModel(result.modelUrl, thing);
          if (destroyed || paused) {
            disposeObject(model);
            return;
          }
          thing.generationStatus = "ready";
          const oldMesh = generatedMeshes.get(thing.id);
          if (oldMesh) {
            scene.remove(oldMesh);
            disposeObject(oldMesh);
          }
          generatedMeshes.set(thing.id, model);
          scene.add(model);
          addLog({
            agentId: "world",
            agentName: "InstantMesh",
            tool: "interact",
            text: `Loaded InstantMesh GLB into the scene for ${thing.kind}: ${thing.prompt}`,
          });
          publish();
        })
        .catch((error) => {
          if (paused || generationController.signal.aborted) {
            thing.generationStatus = "local";
            showLocalFallbackMesh();
            publish();
            return;
          }
          thing.generationStatus = "failed";
          showLocalFallbackMesh();
          addLog({
            agentId: "world",
            agentName: "InstantMesh",
            tool: "interact",
            text: `InstantMesh generation fell back to local mesh: ${
              error instanceof Error ? sanitizeLogText(error.message) : "unknown error"
            }`,
          });
          publish();
        })
        .finally(() => {
          pendingGenerationControllers.delete(thing.id);
        });
    }
    return thing;
  };

  const interact = (request: InteractRequest): TellusLog => {
    const actor = agents.find((agent) => agent.id === request.actorId);
    const target = generated.find((thing) => thing.id === request.targetId);
    return addLog({
      agentId: request.actorId,
      agentName: actor?.name ?? "Visitor",
      tool: "interact",
      text: `${actor?.name ?? "Visitor"} interacts with ${target?.kind ?? "the world"}: ${request.intent}`,
    });
  };

  const talkToAgent = (agentId: AgentId, message: string) => {
    const trimmed = message.trim();
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!trimmed || !agent) return;
    if (paused) {
      addLog({
        agentId: "world",
        agentName: "Tellus",
        tool: "interact",
        text: "Paused: agent chatter is stopped.",
      });
      return;
    }

    addLog({
      agentId: "visitor",
      agentName: "Visitor",
      tool: "interact",
      text: `asks ${agent.name}: ${trimmed}`,
    });

    void askAgentForReply(agent, trimmed, generated, logs)
      .then((reply) => {
        if (destroyed || paused) return;
        addLog({
          agentId: agent.id,
          agentName: agent.name,
          tool: "interact",
          text: `${agent.name} says: ${reply}`,
        });
      })
      .catch((error) => {
        if (destroyed || paused) return;
        addLog({
          agentId: agent.id,
          agentName: agent.name,
          tool: "interact",
          text: `${agent.name} tries to answer, but the voice link is quiet (${
            error instanceof Error ? error.message : "unknown error"
          })`,
        });
      });
  };

  const submitVisitorPrompt = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (paused) {
      addLog({
        agentId: "world",
        agentName: "Tellus",
        tool: "generate",
        text: "Paused: generation is stopped.",
      });
      return;
    }
    if (trimmed.toLowerCase().startsWith("ask ") && generated.length > 0) {
      interact({
        targetId: generated[generated.length - 1].id,
        intent: trimmed,
        actorId: "visitor",
      });
      return;
    }
    generate({
      prompt: trimmed,
      location: {
        x: visitorPosition.x + Math.sin(yaw) * 4,
        y: 0,
        z: visitorPosition.z + Math.cos(yaw) * 4,
      },
      creatorId: "visitor",
    });
  };

  const setPaused = (nextPaused: boolean) => {
    if (paused === nextPaused) return;
    paused = nextPaused;
    if (paused) {
      abortPendingGeneration();
      for (const thing of generated) {
        if (
          thing.generationStatus === "queued" ||
          thing.generationStatus === "generating"
        ) {
          thing.generationStatus = "local";
        }
      }
    }
    if (!paused) {
      const now = performance.now();
      for (const agent of agents) {
        agent.nextActionAt = now + AUTONOMOUS_ASSET_INTERVAL_MS;
        agent.nextReflectionAt = now + AUTONOMOUS_REFLECTION_OFFSET_MS;
      }
    }
    addLog({
      agentId: "world",
      agentName: "Tellus",
      tool: "interact",
      text: paused
        ? "Paused: agent chatter and generation are stopped."
        : "Resumed: agents may talk and generate again.",
    });
    publish();
  };

  const runAgentTurn = async (agent: TellusAgent): Promise<void> => {
    if (paused) return;
    if (pendingAgentDecisions.has(agent.id)) return;
    pendingAgentDecisions.add(agent.id);
    try {
      if (paused) return;
      const decision = await askAgentForDecision(agent, generated, logs);
      if (destroyed || paused) return;
      if (decision.speech) {
        addLog({
          agentId: agent.id,
          agentName: agent.name,
          tool: "interact",
          text: `${agent.name} says: ${decision.speech}`,
        });
      }
      const thing = generate({
        prompt: decision.prompt,
        location: chooseAgentLocation(agent, decision.prompt),
        creatorId: agent.id,
      });
      if (decision.intent) {
        if (paused) return;
        interact({
          targetId: thing.id,
          actorId: agent.id,
          intent: decision.intent,
        });
      }
    } catch (error) {
      if (destroyed || paused) return;
      addLog({
        agentId: "world",
        agentName: "Hyades",
        tool: "interact",
        text: `Agent model unavailable; using local behavior (${
          error instanceof Error ? error.message : "unknown error"
        })`,
      });
      const fallbackPrompt = chooseAgentPrompt(agent, generated);
      generate({
        prompt: fallbackPrompt,
        location: chooseAgentLocation(agent, fallbackPrompt),
        creatorId: agent.id,
      });
    } finally {
      pendingAgentDecisions.delete(agent.id);
    }
  };

  const runAgentReflection = (agent: TellusAgent): void => {
    if (paused || generated.length === 0) return;
    const target =
      generated[
        Math.floor(rand(performance.now() + agent.position.x) * generated.length)
      ];
    interact({
      targetId: target.id,
      actorId: agent.id,
      intent:
        agent.id === "johnny"
          ? "study what should live near here next and how this asset changes the world"
          : agent.id === "mira"
            ? "study what should live near here next and how this asset changes the local habitat"
            : "study what should live near here next and whether it belongs in the mountain pattern",
    });
  };

  const resize = () => {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer?.setSize(width, height, false);
  };

  const moveVisitor = (delta: number) => {
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const movement = new THREE.Vector3();
    if (keys.has("w")) movement.add(forward);
    if (keys.has("s")) movement.sub(forward);
    if (keys.has("d")) movement.add(right);
    if (keys.has("a")) movement.sub(right);
    if (movement.lengthSq() === 0) return;
    movement.normalize().multiplyScalar(PLAYER_SPEED * delta);
    if (sailingThingId) {
      const boat = thingById(sailingThingId);
      if (!boat) {
        sailingThingId = undefined;
        return;
      }
      boat.position = movedVehiclePosition(
        boat,
        boat.position.x + movement.x,
        boat.position.z + movement.z,
      );
      visitorPosition = { ...boat.position };
      const mesh = generatedMeshes.get(boat.id);
      if (mesh) {
        mesh.position.set(boat.position.x, boat.position.y, boat.position.z);
        if (movement.lengthSq() > 0.001) {
          mesh.rotation.y = Math.atan2(movement.x, movement.z);
        }
      }
      publish();
      return;
    }
    visitorPosition = normalizedDiscPosition(
      visitorPosition.x + movement.x,
      visitorPosition.z + movement.z,
    );
  };

  const moveAgents = (now: number, delta: number) => {
    for (const agent of agents) {
      if (distance2D(agent.position, agent.target) < 1.2) {
        const angle = rand(now * 0.001 + agent.position.x) * Math.PI * 2;
        const radius = 7 + rand(now * 0.002 + agent.position.z) * 22;
        agent.target = normalizedDiscPosition(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius,
        );
      }
      const direction = new THREE.Vector3(
        agent.target.x - agent.position.x,
        0,
        agent.target.z - agent.position.z,
      );
      if (direction.lengthSq() > 0.001) {
        direction.normalize().multiplyScalar(AGENT_SPEED * delta);
        agent.position = normalizedDiscPosition(
          agent.position.x + direction.x,
          agent.position.z + direction.z,
        );
      }

      if (!paused && now >= agent.nextActionAt) {
        void runAgentTurn(agent);
        agent.nextActionAt = now + AUTONOMOUS_ASSET_INTERVAL_MS;
        agent.nextReflectionAt = now + AUTONOMOUS_REFLECTION_OFFSET_MS;
      } else if (!paused && now >= agent.nextReflectionAt) {
        runAgentReflection(agent);
        agent.nextReflectionAt = now + AUTONOMOUS_ASSET_INTERVAL_MS;
      }
    }
  };

  const syncMeshes = (now: number) => {
    visitor.position.set(
      visitorPosition.x,
      visitorPosition.y,
      visitorPosition.z,
    );
    visitor.rotation.y = yaw;

    const pondSurface = pondWater.getObjectByName("tellus-pond-surface");
    if (pondSurface) {
      pondSurface.position.y =
        terrainHeight(POND_CENTER.x, POND_CENTER.z) +
        0.55 +
        Math.sin(now * 0.0018) * 0.045;
      pondSurface.rotation.z = Math.sin(now * 0.0004) * 0.08;
    }

    const ripples = pondWater.getObjectByName("tellus-pond-ripples");
    if (ripples) {
      ripples.children.forEach((child, index) => {
        const phase = (now * 0.00028 + index * 0.23) % 1;
        const scale = POND_RADIUS * (0.22 + phase * 0.72);
        child.scale.setScalar(scale);
        const material = (child as THREE.Mesh).material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = Math.max(0, 0.32 * (1 - phase));
        }
      });
    }

    const waterVeil = pondWater.getObjectByName("tellus-water-distortion-veil");
    if (waterVeil) {
      waterVeil.rotation.z = now * 0.00018;
      const material = (waterVeil as THREE.Mesh).material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 0.12 + Math.sin(now * 0.0017) * 0.035;
      }
    }

    for (const agent of agents) {
      const mesh = agentMeshes.get(agent.id);
      if (!mesh) continue;
      mesh.position.set(agent.position.x, agent.position.y, agent.position.z);
      mesh.lookAt(agent.target.x, agent.position.y, agent.target.z);
      mesh.position.y += Math.sin(now * 0.004 + agent.color) * 0.08;
    }

    let index = 0;
    for (const mesh of generatedMeshes.values()) {
      if (mesh.userData.generatingSwirl) {
        mesh.rotation.y = now * 0.0022 + index;
        mesh.position.y =
          (typeof mesh.userData.baseY === "number"
            ? mesh.userData.baseY
            : mesh.position.y) + Math.sin(now * 0.004 + index) * 0.045;
        for (const child of mesh.children) {
          if (child.userData.swirlRing !== undefined) {
            child.rotation.z =
              now * (0.0028 + child.userData.swirlRing * 0.0007);
            child.scale.setScalar(
              0.78 +
                child.userData.swirlRing * 0.18 +
                Math.sin(now * 0.004 + child.userData.swirlRing) * 0.045,
            );
          }
          if (child.userData.swirlSpark !== undefined) {
            const angle =
              child.userData.baseAngle +
              now * (0.003 + child.userData.swirlSpark * 0.00018);
            const radius =
              0.44 + Math.sin(now * 0.003 + child.userData.swirlSpark) * 0.16;
            child.position.set(
              Math.cos(angle) * radius,
              0.75 +
                child.userData.swirlSpark * 0.075 +
                Math.sin(now * 0.005 + child.userData.swirlSpark) * 0.12,
              Math.sin(angle) * radius,
            );
          }
        }
      }
      index++;
    }
  };

  const updateCamera = () => {
    const pilotedThing = sailingThingId ? thingById(sailingThingId) : undefined;
    const pilotedMode = pilotedThing ? vehicleMode(pilotedThing) : null;
    const targetY =
      pilotedMode === "water"
        ? SEA_LEVEL + 4.8
        : pilotedMode === "air"
          ? visitorPosition.y + 1.8
          : visitorPosition.y + 2.7;
    const target = new THREE.Vector3(
      visitorPosition.x,
      targetY,
      visitorPosition.z,
    );
    const offset = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch) * -zoom,
      Math.sin(-pitch) * zoom + 2.2,
      Math.cos(yaw) * Math.cos(pitch) * -zoom,
    );
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  };

  const animate = async () => {
    if (destroyed || !renderer) return;
    const now = performance.now();
    const delta = clamp((now - lastTime) / 1000, 0, 0.05);
    lastTime = now;
    tick++;
    moveVisitor(delta);
    moveAgents(now, delta);
    syncMeshes(now);
    updateCamera();
    try {
      renderer.render(scene, camera);
    } catch (error) {
      if (!renderIssueLogged) {
        renderIssueLogged = true;
        addLog({
          agentId: "world",
          agentName: "Tellus",
          tool: "interact",
          text: `WebGPU render failed: ${error instanceof Error ? error.message : "unknown renderer error"}`,
        });
      }
    }
    if (!destroyed) {
      animationId = requestAnimationFrame(() => void animate());
    }
  };

  const handleKeyDown = (event: KeyboardEvent) =>
    keys.add(event.key.toLowerCase());
  const handleKeyUp = (event: KeyboardEvent) =>
    keys.delete(event.key.toLowerCase());
  const handlePointerDown = (event: PointerEvent) => {
    isDragging = true;
    pointerTravel = 0;
    pointerX = event.clientX;
    pointerY = event.clientY;
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (!isDragging) return;
    const dx = event.clientX - pointerX;
    const dy = event.clientY - pointerY;
    pointerTravel += Math.hypot(dx, dy);
    pointerX = event.clientX;
    pointerY = event.clientY;
    yaw -= dx * 0.006;
    pitch = clamp(pitch - dy * 0.003, -0.82, -0.08);
  };
  const selectGeneratedAtPointer = (event: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const intersections = raycaster.intersectObjects(
      [...generatedMeshes.values()],
      true,
    );
    for (const intersection of intersections) {
      let object: THREE.Object3D | null = intersection.object;
      while (object) {
        const tellusId = object.userData.tellusId;
        if (typeof tellusId === "string") {
          selectGenerated(tellusId);
          return;
        }
        object = object.parent;
      }
    }
  };
  const handlePointerUp = (event: PointerEvent) => {
    if (isDragging && pointerTravel < 6) {
      selectGeneratedAtPointer(event);
    }
    isDragging = false;
  };
  const handleWheel = (event: WheelEvent) => {
    zoom = clamp(zoom + event.deltaY * 0.01, 12, 58);
  };

  window.addEventListener("resize", resize);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  container.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  container.addEventListener("wheel", handleWheel, { passive: true });

  const init = async () => {
    if (!("gpu" in navigator)) {
      addLog({
        agentId: "world",
        agentName: "Tellus",
        tool: "interact",
        text: "WebGPU is not available in this browser. Tellus needs WebGPU.",
      });
      return;
    }

    try {
      renderer = new WebGPURenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      await renderer.init();
      container.appendChild(renderer.domElement);
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(container);
      resize();
      requestAnimationFrame(resize);
      publish();
      for (const agent of agents) {
        void loadAgentAvatar(agent)
          .then((avatar) => {
            if (!avatar || destroyed) return;
            const agentRoot = agentMeshes.get(agent.id);
            if (!agentRoot) return;
            for (const child of [...agentRoot.children]) {
              agentRoot.remove(child);
              disposeObject(child);
            }
            agentRoot.add(avatar);
            addLog({
              agentId: "world",
              agentName: "Tellus",
              tool: "interact",
              text: `Loaded avatar for ${agent.name}`,
            });
          })
          .catch((error) => {
            addLog({
              agentId: "world",
              agentName: "Tellus",
              tool: "interact",
              text: `Avatar load failed for ${agent.name}: ${
                error instanceof Error ? error.message : "unknown avatar error"
              }`,
            });
          });
      }
      void loadSkyboxModel()
        .then((skybox) => {
          if (!skybox || destroyed) return;
          scene.remove(fallbackSky);
          fallbackSky.geometry.dispose();
          disposeMaterial(fallbackSky.material);
          scene.add(skybox);
          addLog({
            agentId: "world",
            agentName: "Tellus",
            tool: "interact",
            text: "Loaded external skybox: free_-_skybox_basic_sky.glb",
          });
        })
        .catch((error) => {
          addLog({
            agentId: "world",
            agentName: "Tellus",
            tool: "interact",
            text: `Skybox load failed: ${error instanceof Error ? error.message : "unknown skybox error"}`,
          });
        });
      for (const agent of agents) {
        addLog({
          agentId: agent.id,
          agentName: agent.name,
          tool: "interact",
          text: `${agent.name} arrives: ${agent.goal}`,
        });
      }
      void animate();
    } catch (error) {
      addLog({
        agentId: "world",
        agentName: "Tellus",
        tool: "interact",
        text: `WebGPU initialization failed: ${error instanceof Error ? error.message : "unknown initialization error"}`,
      });
    }
  };

  void init();

  return {
    generate,
    interact,
    selectGenerated,
    moveGenerated,
    moveGeneratedToWater,
    boardGenerated,
    disembark,
    talkToAgent,
    setPaused,
    submitVisitorPrompt,
    snapshot,
    destroy: () => {
      destroyed = true;
      abortPendingGeneration();
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      container.removeEventListener("wheel", handleWheel);
      resizeObserver?.disconnect();
      renderer?.dispose();
      if (renderer?.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}

function useSpeechInput(onText: (text: string) => void): {
  listening: boolean;
  supported: boolean;
  start: () => void;
} {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supported =
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  const start = () => {
    const Recognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition || listening) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const result = event.results[0]?.[0]?.transcript;
      if (result) onText(result);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return { listening, supported, start };
}

function App(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<TellusWorldApi | null>(null);
  const [snapshot, setSnapshot] = useState<TellusSnapshot>({
    agents: createAgentSeeds(),
    generated: [],
    logs: [],
    paused: false,
  });
  const [prompt, setPrompt] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("johnny");
  const { listening, supported, start } = useSpeechInput((text) =>
    setPrompt(text),
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let world: TellusWorldApi | null = null;
    void loadRuntimeConfig()
      .catch((error) => {
        console.warn("Tellus runtime config failed to load", error);
      })
      .then(() => {
        if (cancelled) return;
        world = createTellusWorld(container, setSnapshot);
        worldRef.current = world;
      });
    return () => {
      cancelled = true;
      world?.destroy();
      worldRef.current = null;
    };
  }, []);

  const selected = useMemo(
    () =>
      snapshot.agents.find((agent) => agent.id === selectedAgent) ??
      snapshot.agents[0],
    [selectedAgent, snapshot.agents],
  );
  const selectedThing = useMemo(
    () =>
      snapshot.generated.find((thing) => thing.id === snapshot.selectedThingId) ??
      snapshot.generated[snapshot.generated.length - 1],
    [snapshot.generated, snapshot.selectedThingId],
  );
  const selectedThingVehicleMode = selectedThing ? vehicleMode(selectedThing) : null;

  const submitPrompt = () => {
    worldRef.current?.submitVisitorPrompt(prompt);
    setPrompt("");
  };

  const askSelectedAgent = () => {
    if (!prompt.trim() || !selected) return;
    worldRef.current?.talkToAgent(selected.id, prompt);
    setPrompt("");
  };

  const recentLogs = snapshot.logs.slice(-10).reverse();

  return (
    <main className="tellus-shell">
      <section className="world-panel" aria-label="Tellus world">
        <div ref={containerRef} className="world-canvas" />
        <div className="brand-mark">
          <span>Tellus</span>
          <small>AI terrarium</small>
        </div>
        <div className="world-help">
          <span>WASD</span>
          <span>drag to look</span>
          <span>scroll to zoom</span>
          {snapshot.sailingThingId && <span>piloting</span>}
        </div>
      </section>

      <aside className="control-panel">
        <header className="panel-header">
          <div>
            <p>Living World MVP</p>
            <h1>Tellus</h1>
          </div>
          <button
            type="button"
            className="icon-button"
            title={snapshot.paused ? "Resume agents" : "Pause agents"}
            onClick={() => worldRef.current?.setPaused(!snapshot.paused)}
          >
            {snapshot.paused ? <Play size={18} /> : <Pause size={18} />}
          </button>
        </header>

        <div className="stat-grid">
          <div>
            <Box size={16} />
            <strong>{snapshot.generated.length}</strong>
            <span>generated</span>
          </div>
          <div>
            <Bot size={16} />
            <strong>{snapshot.agents.length}</strong>
            <span>agents</span>
          </div>
          <div>
            <Mountain size={16} />
            <strong>1</strong>
            <span>disc</span>
          </div>
        </div>

        <section className="tool-card">
          <div className="tool-title">
            <Wand2 size={16} />
            <span>Asset tools</span>
          </div>
          <div className="tool-list">
            <code>generate(request)</code>
            <code>interact(target, intent)</code>
          </div>
        </section>

        <section className="prompt-card">
          <label htmlFor="tellus-prompt">Speak or type a world request</label>
          <textarea
            id="tellus-prompt"
            value={prompt}
            rows={4}
            placeholder="make a crooked apple tree with golden moss..."
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="prompt-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={!supported || listening}
              onClick={start}
            >
              <Mic size={16} />
              <span>{listening ? "Listening" : "Voice"}</span>
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={askSelectedAgent}
            >
              <MessageCircle size={16} />
              <span>Discuss</span>
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={submitPrompt}
            >
              <Send size={16} />
              <span>Generate</span>
            </button>
          </div>
        </section>

        {selectedThing && (
          <section className="asset-card">
            <div className="section-heading">
              <Compass size={16} />
              <span>Position Asset</span>
            </div>
            <select
              className="asset-select"
              value={selectedThing.id}
              onChange={(event) =>
                worldRef.current?.selectGenerated(event.target.value)
              }
            >
              {snapshot.generated.map((thing) => (
                <option key={thing.id} value={thing.id}>
                  {thing.kind}: {thing.prompt.slice(0, 42)}
                </option>
              ))}
            </select>
            <div className="asset-meta">
              <span>{selectedThing.generationStatus ?? "local"}</span>
              <span>
                x {selectedThing.position.x.toFixed(1)} z{" "}
                {selectedThing.position.z.toFixed(1)}
              </span>
            </div>
            <div className="nudge-grid">
              <button
                type="button"
                className="secondary-button"
                onClick={() => worldRef.current?.moveGenerated(selectedThing.id, 0, -2)}
              >
                <span>N</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => worldRef.current?.moveGenerated(selectedThing.id, -2, 0)}
              >
                <span>W</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => worldRef.current?.moveGeneratedToWater(selectedThing.id)}
              >
                <span>
                  {selectedThingVehicleMode === "air"
                    ? "Lift"
                    : selectedThingVehicleMode === "water"
                      ? "Water"
                      : "Edge"}
                </span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => worldRef.current?.moveGenerated(selectedThing.id, 2, 0)}
              >
                <span>E</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => worldRef.current?.moveGenerated(selectedThing.id, 0, 2)}
              >
                <span>S</span>
              </button>
            </div>
            {selectedThingVehicleMode && (
              <button
                type="button"
                className="primary-button wide-button"
                onClick={() =>
                  snapshot.sailingThingId === selectedThing.id
                    ? worldRef.current?.disembark()
                    : worldRef.current?.boardGenerated(selectedThing.id)
                }
              >
                <Ship size={16} />
                <span>
                  {snapshot.sailingThingId === selectedThing.id
                    ? "Disembark"
                    : "Board and Pilot"}
                </span>
              </button>
            )}
          </section>
        )}

        <section className="agents-card">
          <div className="section-heading">
            <Sparkles size={16} />
            <span>Enabled AI</span>
          </div>
          <div className="agent-list">
            {snapshot.agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={
                  agent.id === selectedAgent ? "agent-row active" : "agent-row"
                }
                onClick={() => setSelectedAgent(agent.id)}
              >
                <span
                  className="agent-dot"
                  style={{
                    backgroundColor: `#${agent.color.toString(16).padStart(6, "0")}`,
                  }}
                />
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.epithet}</small>
                </span>
              </button>
            ))}
          </div>
          {selected && <p className="agent-goal">{selected.goal}</p>}
        </section>

        <section className="log-card">
          <div className="section-heading">
            <Leaf size={16} />
            <span>World log</span>
          </div>
          <div className="log-list">
            {recentLogs.map((log) => (
              <article key={log.id} className={`log-entry ${log.tool}`}>
                <strong>{log.tool}</strong>
                <p>{log.text}</p>
              </article>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Tellus root element was not found");
}

const tellusRoot = window.__tellusRoot ?? createRoot(root);
window.__tellusRoot = tellusRoot;

tellusRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
