export type TerrainPaintKind = "meadow" | "rock" | "snow" | "beach" | "dirt";
export type TerrainEditMode = "raise" | "lower" | "flatten" | TerrainPaintKind;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TellusTerrainState {
  version: number;
  revision: number;
  terrainSculptOffsets: number[];
  terrainPaint: number[];
  distantIslandSculptOffsets: Record<string, number[]>;
  distantIslandPaint: Record<string, number[]>;
  savedAt: string;
}

export interface WorldPresence {
  visitorId: string;
  name?: string;
  position?: Vec3;
  connectedAt: string;
  lastSeenAt: string;
}

export interface GenerationJobRequest {
  prompt: string;
  creatorId: string;
  location?: Vec3 | "near-agent" | "near-mountain" | "near-pond";
  scale?: number;
}

export interface WorldGeneratedThing {
  id: string;
  kind: string;
  prompt: string;
  creatorId: string;
  position: Vec3;
  rotationY: number;
  scale: number;
  color: number;
  modelUrl?: string;
  pipelineId?: string;
  generationStatus?: "local" | "queued" | "generating" | "ready" | "failed";
  updatedAt: string;
}

export type WorldAction =
  | {
      type: "presence.update";
      visitorId: string;
      name?: string;
      position?: Vec3;
    }
  | {
      type: "terrain.replace";
      visitorId: string;
      terrain: TellusTerrainState;
    }
  | {
      type: "terrain.sculpt";
      visitorId: string;
      mode: TerrainEditMode;
      center: Vec3;
    }
  | {
      type: "generation.request";
      visitorId: string;
      request: GenerationJobRequest;
    }
  | {
      type: "generated.upsert";
      visitorId: string;
      thing: WorldGeneratedThing;
    }
  | {
      type: "generated.delete";
      visitorId: string;
      id: string;
    };

export type WorldPatch =
  | {
      type: "world.snapshot";
      worldId: string;
      terrain: TellusTerrainState;
      presence: WorldPresence[];
      generated: WorldGeneratedThing[];
      queuedGenerationJobs: QueuedGenerationJob[];
    }
  | {
      type: "presence.updated";
      presence: WorldPresence[];
    }
  | {
      type: "terrain.updated";
      terrain: TellusTerrainState;
      actorId: string;
    }
  | {
      type: "generation.queued";
      job: QueuedGenerationJob;
    }
  | {
      type: "generated.updated";
      thing: WorldGeneratedThing;
      actorId: string;
    }
  | {
      type: "generated.deleted";
      id: string;
      actorId: string;
    }
  | {
      type: "action.rejected";
      actionType: string;
      reason: string;
    };

export interface QueuedGenerationJob {
  id: string;
  worldId: string;
  request: GenerationJobRequest;
  status: "queued" | "generating" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isVec3(value: unknown): value is Vec3 {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.z === "number" &&
    Number.isFinite(value.z)
  );
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function isNumberArrayRecord(value: unknown): value is Record<string, number[]> {
  return isRecord(value) && Object.values(value).every(isNumberArray);
}

export function isWorldGeneratedThing(value: unknown): value is WorldGeneratedThing {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.creatorId !== "string" ||
    !isVec3(value.position) ||
    typeof value.rotationY !== "number" ||
    !Number.isFinite(value.rotationY) ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    typeof value.color !== "number" ||
    !Number.isFinite(value.color) ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }
  return (
    (value.modelUrl === undefined || typeof value.modelUrl === "string") &&
    (value.pipelineId === undefined || typeof value.pipelineId === "string") &&
    (value.generationStatus === undefined ||
      value.generationStatus === "local" ||
      value.generationStatus === "queued" ||
      value.generationStatus === "generating" ||
      value.generationStatus === "ready" ||
      value.generationStatus === "failed")
  );
}

export function isTellusTerrainState(value: unknown): value is TellusTerrainState {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.revision === "number" &&
    isNumberArray(value.terrainSculptOffsets) &&
    isNumberArray(value.terrainPaint) &&
    isNumberArrayRecord(value.distantIslandSculptOffsets) &&
    isNumberArrayRecord(value.distantIslandPaint) &&
    typeof value.savedAt === "string"
  );
}

export function isWorldAction(value: unknown): value is WorldAction {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.visitorId !== "string") {
    return false;
  }
  if (value.type === "presence.update") {
    return value.position === undefined || isVec3(value.position);
  }
  if (value.type === "terrain.replace") {
    return isTellusTerrainState(value.terrain);
  }
  if (value.type === "terrain.sculpt") {
    return typeof value.mode === "string" && isVec3(value.center);
  }
  if (value.type === "generation.request") {
    return isRecord(value.request) && typeof value.request.prompt === "string";
  }
  if (value.type === "generated.upsert") {
    return isWorldGeneratedThing(value.thing);
  }
  if (value.type === "generated.delete") {
    return typeof value.id === "string";
  }
  return false;
}
