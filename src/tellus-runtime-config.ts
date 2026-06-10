import type {
  AgentId,
  InstantMeshTarget,
  RoleGenerationProvider,
  TellusRuntimeConfig,
} from "./tellus-types";
import {
  allAgentIds,
  DEFAULT_DAY_NIGHT_CYCLE_MS,
  DEFAULT_DAY_NIGHT_START,
  MIN_DAY_NIGHT_CYCLE_MS,
} from "./tellus-constants";
import { boundedNumber, isRecord, readJsonResponse } from "./tellus-utils";

export const runtimeConfig: TellusRuntimeConfig = {
  apiBase:
    import.meta.env.VITE_TELLUS_API_BASE?.replace(/\/+$/, "") ?? "",
  assetForgeApiBase:
    import.meta.env.VITE_ASSET_FORGE_API_BASE?.replace(/\/+$/, "") ?? "",
  agentModel:
    import.meta.env.VITE_TELLUS_AGENT_MODEL ??
    "GLM-5.1",
  generationProvider:
    (import.meta.env.VITE_TELLUS_GENERATION_PROVIDER as
      | TellusRuntimeConfig["generationProvider"]
      | undefined) ?? "instantmesh-gradio",
  playerGenerationProvider:
    (import.meta.env.VITE_TELLUS_PLAYER_GENERATION_PROVIDER as
      | RoleGenerationProvider
      | undefined) ?? "instantmesh-gradio",
  agentGenerationProvider:
    (import.meta.env.VITE_TELLUS_AGENT_GENERATION_PROVIDER as
      | RoleGenerationProvider
      | undefined) ?? "pixal3d-gradio",
  instantMeshTarget:
    (import.meta.env.VITE_TELLUS_INSTANTMESH_TARGET as InstantMeshTarget | undefined) ??
    "dgx",
  instantMeshTargets: {
    dgx:
      import.meta.env.VITE_TELLUS_INSTANTMESH_DGX_URL?.replace(/\/+$/, "") ??
      "http://192.168.1.177:43839",
    local:
      import.meta.env.VITE_TELLUS_INSTANTMESH_LOCAL_URL?.replace(/\/+$/, "") ??
      "http://127.0.0.1:43839",
  },
  worldApiBase:
    import.meta.env.VITE_TELLUS_WORLD_API_BASE?.replace(/\/+$/, "") ?? "",
  worldId: import.meta.env.VITE_TELLUS_WORLD_ID ?? "main",
  skyboxUrl: import.meta.env.VITE_TELLUS_SKYBOX_URL ?? "",
  dayNightCycleMs: boundedNumber(
    import.meta.env.VITE_TELLUS_DAY_NIGHT_CYCLE_MS,
    DEFAULT_DAY_NIGHT_CYCLE_MS,
    MIN_DAY_NIGHT_CYCLE_MS,
    60 * 60 * 1000,
  ),
  dayNightStart: boundedNumber(
    import.meta.env.VITE_TELLUS_DAY_NIGHT_START,
    DEFAULT_DAY_NIGHT_START,
    0,
    1,
  ),
  enabledAgents: ["johnny"],
  avatars: {
    johnny: import.meta.env.VITE_TELLUS_JOHNNY_AVATAR_URL,
    mira: import.meta.env.VITE_TELLUS_MIRA_AVATAR_URL,
    sol: import.meta.env.VITE_TELLUS_SOL_AVATAR_URL,
  },
  instanceStaticDuplicates:
    import.meta.env.VITE_TELLUS_INSTANCE_STATIC === "true",
};

export function applyRuntimeConfig(config: unknown): void {
  if (!isRecord(config)) return;

  const assetForgeApiBase = config.assetForgeApiBase;
  if (
    !import.meta.env.VITE_ASSET_FORGE_API_BASE?.trim() &&
    typeof assetForgeApiBase === "string" &&
    assetForgeApiBase.trim()
  ) {
    runtimeConfig.assetForgeApiBase = assetForgeApiBase.trim().replace(/\/+$/, "");
  }

  const apiBase = config.apiBase;
  if (
    !import.meta.env.VITE_TELLUS_API_BASE?.trim() &&
    typeof apiBase === "string"
  ) {
    runtimeConfig.apiBase = apiBase.trim().replace(/\/+$/, "");
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
      generationProvider === "instantmesh-gradio" ||
      generationProvider === "pixal3d-gradio" ||
      generationProvider === "anigen-gradio")
  ) {
    runtimeConfig.generationProvider = generationProvider;
  }

  const playerGenerationProvider = config.playerGenerationProvider;
  if (
    !import.meta.env.VITE_TELLUS_PLAYER_GENERATION_PROVIDER?.trim() &&
    (playerGenerationProvider === "local" ||
      playerGenerationProvider === "instantmesh-gradio" ||
      playerGenerationProvider === "pixal3d-gradio" ||
      playerGenerationProvider === "anigen-gradio")
  ) {
    runtimeConfig.playerGenerationProvider = playerGenerationProvider;
  }

  const agentGenerationProvider = config.agentGenerationProvider;
  if (
    !import.meta.env.VITE_TELLUS_AGENT_GENERATION_PROVIDER?.trim() &&
    (agentGenerationProvider === "local" ||
      agentGenerationProvider === "instantmesh-gradio" ||
      agentGenerationProvider === "pixal3d-gradio" ||
      agentGenerationProvider === "anigen-gradio")
  ) {
    runtimeConfig.agentGenerationProvider = agentGenerationProvider;
  }

  const instantMeshTarget = config.instantMeshTarget;
  if (
    !import.meta.env.VITE_TELLUS_INSTANTMESH_TARGET?.trim() &&
    (instantMeshTarget === "dgx" || instantMeshTarget === "local")
  ) {
    runtimeConfig.instantMeshTarget = instantMeshTarget;
  }

  const instantMeshTargets = config.instantMeshTargets;
  if (isRecord(instantMeshTargets)) {
    for (const target of ["dgx", "local"] as const) {
      const baseUrl = instantMeshTargets[target];
      if (typeof baseUrl === "string" && baseUrl.trim()) {
        runtimeConfig.instantMeshTargets[target] = baseUrl.trim().replace(/\/+$/, "");
      }
    }
  }

  const skyboxUrl = config.skyboxUrl;
  if (typeof skyboxUrl === "string" && skyboxUrl.trim()) {
    runtimeConfig.skyboxUrl = skyboxUrl.trim();
  }

  const dayNightCycleMs = config.dayNightCycleMs;
  if (typeof dayNightCycleMs === "number") {
    runtimeConfig.dayNightCycleMs = boundedNumber(
      dayNightCycleMs,
      runtimeConfig.dayNightCycleMs,
      MIN_DAY_NIGHT_CYCLE_MS,
      60 * 60 * 1000,
    );
  }

  const dayNightStart = config.dayNightStart;
  if (typeof dayNightStart === "number") {
    runtimeConfig.dayNightStart = boundedNumber(
      dayNightStart,
      runtimeConfig.dayNightStart,
      0,
      1,
    );
  }

  const worldApiBase = config.worldApiBase;
  if (
    !import.meta.env.VITE_TELLUS_WORLD_API_BASE?.trim() &&
    typeof worldApiBase === "string"
  ) {
    runtimeConfig.worldApiBase = worldApiBase.trim().replace(/\/+$/, "");
  }

  const worldId = config.worldId;
  if (
    !import.meta.env.VITE_TELLUS_WORLD_ID?.trim() &&
    typeof worldId === "string" &&
    worldId.trim()
  ) {
    runtimeConfig.worldId = worldId.trim();
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

  // Only honour a runtime-config boolean when the VITE build var is unset (mirrors worldApiBase et al.).
  const instanceStaticDuplicates = config.instanceStaticDuplicates;
  if (
    import.meta.env.VITE_TELLUS_INSTANCE_STATIC === undefined &&
    typeof instanceStaticDuplicates === "boolean"
  ) {
    runtimeConfig.instanceStaticDuplicates = instanceStaticDuplicates;
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

export async function loadRuntimeConfigFile(path: string): Promise<void> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 404) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  applyRuntimeConfig(await readJsonResponse<unknown>(response));
}

export async function loadRuntimeConfig(): Promise<void> {
  await loadRuntimeConfigFile("/tellus-config.json");
  if (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  ) {
    await loadRuntimeConfigFile("/tellus-config.local.json");
  }
}
