import type { createRoot } from "react-dom/client";
import type * as THREE from "three";
import type { MeshStats } from "./webrtc-mesh";
import type { WorldGeneratedThing, WorldPresence } from "./world-protocol";

export type AgentId = "johnny" | "mira" | "sol" | "atlas";

export type TerrainKind =
  | "meadow"
  | "rock"
  | "snow"
  | "beach"
  | "dirt"
  | "flowers"
  | "water";
export type TerrainPaintKind = Exclude<TerrainKind, "water">;
export type TerrainEditMode = "raise" | "lower" | "flatten" | TerrainPaintKind;
export type GenerationProvider =
  | "local"
  | "asset-forge"
  | "instantmesh-gradio"
  | "pixal3d-gradio"
  | "anigen-gradio";
export type DirectGenerationProvider = Extract<
  GenerationProvider,
  "instantmesh-gradio" | "pixal3d-gradio" | "anigen-gradio"
>;
export type RoleGenerationProvider = DirectGenerationProvider | "local";
export type InstantMeshTarget = "dgx" | "local";
export type GeneratedKind =
  | "tree"
  | "flower"
  | "stone"
  | "animal"
  | "path"
  | "shrine"
  | "seed"
  | "balloon"
  | "object";

export type ToolName = "generate" | "interact";
export type AssetPanelTab = "search" | "world-assets" | "inventory" | "procedural";
export type ToolMenu = "terrain";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GeneratedThing {
  id: string;
  kind: GeneratedKind;
  prompt: string;
  creatorId: AgentId | "visitor";
  ownerUserId?: string;
  position: Vec3;
  rotationX?: number;
  rotationY: number;
  rotationZ?: number;
  scale: number;
  color: number;
  modelUrl?: string;
  pipelineId?: string;
  generationStatus?: "local" | "queued" | "generating" | "ready" | "failed";
}

export interface AssetLibraryModel {
  id: string;
  name: string;
  description?: string;
  file_format?: string;
  file_size?: number;
  download_count?: number;
  modelUrl?: string;
  source?: "asset-library" | "generated";
  /** Store browse-card extras (3D Asset Manager /models/browse). */
  hasThumbnail?: boolean;
  hasGameOptimized?: boolean;
  tags?: string[];
}

export interface AssetLibraryResponse {
  models?: AssetLibraryModel[];
}

export interface DistantIslandSpec {
  seed: number;
  angle: number;
  distance: number;
  x: number;
  z: number;
  size: number;
  topRadius: number;
  bottomRadius: number;
  height: number;
  scaleZ: number;
  rotationY: number;
  sculptOffsets: Float32Array;
  paint: Uint8Array;
}

export interface TellusLog {
  id: string;
  tick: number;
  agentId: AgentId | "visitor" | "world";
  agentName: string;
  tool: ToolName;
  text: string;
  screenshotUrl?: string;
}

export interface GenerateRequest {
  prompt: string;
  location: Vec3 | "near-agent" | "near-mountain" | "near-pond";
  scale?: number;
  creatorId: AgentId | "visitor";
  ownerUserId?: string;
}

export interface InteractRequest {
  targetId: string;
  intent: string;
  actorId: AgentId | "visitor";
}

export interface TellusSnapshot {
  generated: GeneratedThing[];
  logs: TellusLog[];
  generationProvider: GenerationProvider;
  playerGenerationProvider: RoleGenerationProvider;
  agentGenerationProvider: RoleGenerationProvider;
  instantMeshTarget: InstantMeshTarget;
  userId: string;
  visitorPosition?: Vec3;
  remoteVisitors: WorldPresence[];
  selectedThingId?: string;
  sailingThingId?: string;
}

export interface TellusWorldApi {
  generate(request: GenerateRequest): GeneratedThing;
  addLibraryAsset(model: AssetLibraryModel): GeneratedThing;
  interact(request: InteractRequest): TellusLog;
  selectGenerated(id?: string): void;
  goToGenerated(id: string): void;
  moveGenerated(id: string, dx: number, dz: number): void;
  rotateGenerated(id: string, radians: number, axis?: "x" | "y" | "z"): void;
  scaleGenerated(id: string, multiplier: number): void;
  resetGeneratedScale(id: string): void;
  liftGenerated(id: string, amount: number): void;
  groundGenerated(id: string): void;
  deleteGenerated(id: string): void;
  cloneGenerated(id: string): void;
  moveGeneratedToWater(id: string): void;
  boardGenerated(id: string): void;
  disembark(): void;
  sculptTerrain(mode: TerrainEditMode): void;
  importGeneratedThings(things: WorldGeneratedThing[]): void;
  setGenerationProvider(provider: GenerationProvider): void;
  setPlayerGenerationProvider(provider: RoleGenerationProvider): void;
  setAgentGenerationProvider(provider: RoleGenerationProvider): void;
  setInstantMeshTarget(target: InstantMeshTarget): void;
  submitVisitorPrompt(prompt: string): void;
  snapshot(): TellusSnapshot;
  getFps(): number;
  // ── P2P video controls (RX inbound video, TX local camera) ──
  setRxEnabled(on: boolean): void;
  setTxEnabled(on: boolean): Promise<boolean>;
  setP2pDevices(audioDeviceId?: string, videoDeviceId?: string): Promise<void>;
  setRemoteAudioEnabled(on: boolean): void;
  setMicEnabled(on: boolean): void;
  getP2pStats(): MeshStats | null;
  getSelfStream(): MediaStream | null;
  // ── Avatar picker ──
  // Select a catalog avatar ("classic" | "vrm:<storeId>" | "glb:<storeId>"; "" = deterministic
  // default). Rebuilds the local rig immediately, persists to localStorage and broadcasts over
  // presence so other players swap your avatar too.
  setAvatarSelection(avatarId: string): void;
  getAvatarSelection(): string;
  // Picture-in-picture POV view of the scene from a remote-presence avatar (the player's server-side agent).
  // Pass the agent's visitorId to show its viewport; pass null to hide it.
  setAgentViewport(visitorId: string | null): void;
  // True when that remote-presence avatar mesh is currently in the scene (false => the PiP falls
  // back to the server-held remote-view snapshot instead of a locally rendered POV).
  hasVisitorAvatar(visitorId: string): boolean;
  // Ballistic throw of a placed thing (tumbles, bounces off terrain or splashes + floats, then
  // settles; the rest pose publishes through the normal upsert path). Bound to G when selected.
  throwGenerated(id: string): void;
  // Explicit Move mode: while set, any press/drag on the world repositions that thing (camera orbit
  // suspended). Pass null to exit. Driven by the selected-object "Move" button.
  setMoveMode(id: string | null): void;
  // Agent vision: render the agent avatar's first-person view into a small offscreen target and
  // return it as a JPEG data URL (null when the avatar isn't present). The app uploads this to
  // Hyades so the agent's LLM turn can actually SEE — no headless browser involved.
  captureAgentView(visitorId: string): Promise<string | null>;
  // Live counters for the procedural vegetation + ambient physics (debug overlay).
  getAmbientStats(): {
    vegetation: { tier: number; chunks: number; grassIndices: number; trees: number };
    physicsBodies: number;
  };
  destroy(): void;
}

export interface TellusRuntimeConfig {
  apiBase: string;
  assetForgeApiBase: string;
  agentModel: string;
  generationProvider: GenerationProvider;
  playerGenerationProvider: RoleGenerationProvider;
  agentGenerationProvider: RoleGenerationProvider;
  instantMeshTarget: InstantMeshTarget;
  instantMeshTargets: Record<InstantMeshTarget, string>;
  worldApiBase: string;
  worldId: string;
  skyboxUrl: string;
  dayNightCycleMs: number;
  dayNightStart: number;
  // When true, fold non-selected static (no-animation) duplicate generated placements that share a modelUrl
  // into a shared THREE.InstancedMesh per sub-mesh to cut draw calls. Default OFF — opt in via
  // VITE_TELLUS_INSTANCE_STATIC=true or a runtime-config `instanceStaticDuplicates: true`.
  instanceStaticDuplicates: boolean;
}

export interface AssetForgePipelineStart {
  pipelineId: string;
  status: string;
  message: string;
}

export interface AssetForgePipelineStatus {
  id: string;
  status: "initializing" | "processing" | "completed" | "failed" | string;
  progress: number;
  finalAsset?: {
    modelUrl?: string;
  };
  error?: string;
}

export interface DirectGenerationResponse {
  jobId: string;
  status?: "queued" | "generating" | "completed" | "failed";
  modelUrl?: string;
  provider: string;
  rawModelUrl?: string;
  storedModelUrl?: string;
  storedModelPath?: string;
  sourceImageUrl?: string;
  sourceImagePath?: string;
  textImageProvider?: string;
  manifestUrl?: string;
  error?: string;
}

export interface GeneratedAssetManifestEntry {
  id?: string;
  prompt?: string;
  kind?: string;
  createdAt?: string;
  modelUrl?: string;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export interface SpeechRecognitionLike extends EventTarget {
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

export type MaterialWithTextureMaps = THREE.Material & {
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
};

export type VehicleMode = "water" | "air" | "ground";

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    __tellusRoot?: ReturnType<typeof createRoot>;
    // Optional identity a host (e.g. a headless-browser agent sidecar) can pin BEFORE the app boots, so an
    // embodied external agent appears as a stable, distinct visitor instead of a fresh random one.
    __hyadesIdentity?: { visitorId?: string; avatarUrl?: string };
    // Stable agent-control hook (attached in createTellusWorld). Lets an external driver read world state and
    // take actions through the same in-world dispatch the built-in agents use. Object-literal property names
    // survive the production build (esbuild does not mangle keys / member access by default).
    tellusAgent?: {
      getState: (radius?: number) => unknown;
      getNearby: (radius?: number) => unknown;
      sendAction: (verb: string, args?: Record<string, unknown>) => unknown;
    };
    __tellusSnapshot?: () => TellusSnapshot;
    // Diagnostics for the rigged-VRM avatar upgrade (consumed by smoke tests / the console).
    __tellusAvatarDebug?: () => {
      localVisitorId: string;
      /** The applied catalog selection for the local player ("" = deterministic default). */
      localAvatarId: string;
      rigIds: string[];
      localSkinnedMeshes: number;
      localBodyHidden: boolean;
    };
    __tellusImportGenerated?: (things: unknown) => number;
    __tellusImportSnapshot?: (snapshot: unknown) => number;
    __tellusSaveGeneratedPlacements?: () => number;
  }
}
