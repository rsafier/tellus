import type {
  TellusAgent,
  GeneratedThing,
  TerrainEditMode,
  TerrainPaintKind,
  AgentDecision,
  GenerateRequest,
  Vec3,
  TellusLog,
  ChatCompletionResponse,
} from "./tellus-types";
import { johnnyFallbackIdeas, POND_CENTER, WORLD_RADIUS } from "./tellus-constants";
import { isRecord, finiteNumber, distance2D } from "./tellus-utils";
import { runtimeConfig } from "./tellus-runtime-config";
import { tellusApiUrl } from "./tellus-urls-identity";
import { isTerrainPaintMode, terrainHeight, terrainKind } from "./tellus-terrain";
import { readJsonResponse } from "./tellus-utils";

export function createAgentSeeds(): TellusAgent[] {
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

export function normalizeAssetPrompt(prompt: string): string {
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

export function promptAlreadyExists(prompt: string, generated: GeneratedThing[]): boolean {
  const normalized = normalizeAssetPrompt(prompt);
  if (!normalized) return false;
  return generated.some((thing) => normalizeAssetPrompt(thing.prompt) === normalized);
}

export function terrainEditModeFromValue(value: unknown): TerrainEditMode | undefined {
  if (value === "raise" || value === "lower" || value === "flatten") {
    return value;
  }
  if (typeof value === "string" && isTerrainPaintMode(value as TerrainEditMode)) {
    return value as TerrainPaintKind;
  }
  return undefined;
}

export function agentDecisionAction(value: unknown): AgentDecision["action"] {
  return value === "moveSelf" ||
    value === "sculptTerrain" ||
    value === "moveAsset" ||
    value === "rotateAsset" ||
    value === "scaleAsset" ||
    value === "moveAssetToWater"
    ? value
    : "generate";
}

export function chooseAgentPrompt(
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

export function ensureNovelAgentDecision(
  decision: AgentDecision,
  agent: TellusAgent,
  generated: GeneratedThing[],
): AgentDecision {
  if (decision.action && decision.action !== "generate") {
    return decision;
  }
  const prompt = decision.prompt.trim();
  if (!promptAlreadyExists(prompt, generated)) {
    return { ...decision, action: decision.action ?? "generate", prompt };
  }
  const replacementPrompt = chooseAgentPrompt(agent, generated);
  return {
    ...decision,
    action: "generate",
    prompt: replacementPrompt,
    intent:
      decision.intent ??
      "study what should live near here next and how this new asset changes the world",
    speech:
      decision.speech ??
      "I will add something different so this place keeps unfolding.",
  };
}

export function extractJsonObject(text: string): unknown {
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

export function parseAgentDecision(content: string, fallbackPrompt: string): AgentDecision {
  const parsed = extractJsonObject(content);
  if (isRecord(parsed)) {
    const action = agentDecisionAction(parsed.action);
    const prompt = parsed.prompt;
    const intent = parsed.intent;
    const speech = parsed.speech;
    return {
      action,
      prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : fallbackPrompt,
      intent: typeof intent === "string" && intent.trim() ? intent.trim() : undefined,
      speech: typeof speech === "string" && speech.trim() ? speech.trim() : undefined,
      terrainMode: terrainEditModeFromValue(parsed.terrainMode),
      targetId: typeof parsed.targetId === "string" && parsed.targetId.trim()
        ? parsed.targetId.trim()
        : undefined,
      dx: finiteNumber(parsed.dx),
      dz: finiteNumber(parsed.dz),
      rotation: finiteNumber(parsed.rotation),
      scaleMultiplier: finiteNumber(parsed.scaleMultiplier),
    };
  }
  return { action: "generate", prompt: content.trim() || fallbackPrompt };
}

export function chooseAgentLocation(
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

export function compassDirection(from: Vec3, to: Vec3): string {
  const angle = Math.atan2(to.z - from.z, to.x - from.x);
  const directions = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];
  const index = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % directions.length;
  return directions[index];
}

export function describeAgentPerception(
  agent: TellusAgent,
  generated: GeneratedThing[],
  logs: TellusLog[],
  visualFeedback: string,
): string {
  const groundHeight = terrainHeight(agent.position.x, agent.position.z);
  const localTerrain = terrainKind(agent.position.x, agent.position.z, groundHeight);
  const distanceToPond = Math.hypot(
    agent.position.x - POND_CENTER.x,
    agent.position.z - POND_CENTER.z,
  );
  const distanceToSummit = Math.hypot(agent.position.x, agent.position.z);
  const distanceToShore = Math.max(0, WORLD_RADIUS - Math.hypot(agent.position.x, agent.position.z));
  const nearby = generated
    .map((thing) => ({
      thing,
      distance: distance2D(agent.position, thing.position),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8)
    .map(({ thing, distance }) => {
      const status = thing.generationStatus && thing.generationStatus !== "ready"
        ? `, ${thing.generationStatus}`
        : "";
      return `- id ${thing.id}: ${Math.round(distance)}m ${compassDirection(agent.position, thing.position)}: ${thing.kind} "${thing.prompt}"${status}, ${thing.scale.toFixed(1)}x`;
    })
    .join("\n");
  const lastOwnAsset = [...generated]
    .reverse()
    .find((thing) => thing.creatorId === agent.id);
  const pending = generated
    .filter(
      (thing) =>
        thing.generationStatus === "queued" ||
        thing.generationStatus === "generating",
    )
    .map((thing) => `- ${thing.kind} "${thing.prompt}" by ${thing.creatorId}: ${thing.generationStatus}`)
    .join("\n");
  const recentChanges = logs
    .filter(
      (log) =>
        log.tool === "generate" ||
        log.text.includes("terrain") ||
        log.text.includes("Loaded") ||
        log.text.includes("deleted"),
    )
    .slice(-6)
    .map((log) => `- ${log.agentName}: ${log.text}`)
    .join("\n");

  return [
    `You are at x ${agent.position.x.toFixed(1)}, z ${agent.position.z.toFixed(1)}, on ${localTerrain} terrain at height ${groundHeight.toFixed(1)}.`,
    `Landmarks: pond ${Math.round(distanceToPond)}m away, mountain summit ${Math.round(distanceToSummit)}m away, shore ${Math.round(distanceToShore)}m away.`,
    `Nearby visible assets:\n${nearby || "none nearby"}`,
    `Your last generated asset: ${lastOwnAsset ? `${lastOwnAsset.kind} "${lastOwnAsset.prompt}" (${lastOwnAsset.generationStatus ?? "local"})` : "none yet"}`,
    `Pending asset generation:\n${pending || "none"}`,
    `Recent visible world changes:\n${recentChanges || "none"}`,
    `Visual world feedback from your stable body camera:\n${visualFeedback || "not captured yet"}`,
  ].join("\n\n");
}

export function chatContent(completion: ChatCompletionResponse): string {
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function askAgentForDecision(
  agent: TellusAgent,
  generated: GeneratedThing[],
  logs: TellusLog[],
  visualFeedback: string,
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
  const perception = describeAgentPerception(agent, generated, logs, visualFeedback);
  const controllableObjects = generated
    .slice(-16)
    .map(
      (thing) =>
        `- id ${thing.id}: ${thing.kind} "${thing.prompt}" at x ${thing.position.x.toFixed(1)}, z ${thing.position.z.toFixed(1)}, scale ${thing.scale.toFixed(2)}x`,
    )
    .join("\n");

  const response = await fetch(tellusApiUrl("/api/chat"), {
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
            "You are an enabled autonomous AI inside Tellus, a tiny living WebGPU world. You can perceive a textual view and a visual screenshot from your own stable body camera, not the visitor camera. Choose exactly one world action. Return only JSON. Use action \"moveSelf\" with dx and dz between -8 and 8 to walk your own body to a better viewpoint. Use action \"generate\" with keys prompt, intent, speech to add one single asset. Or use action \"sculptTerrain\" with terrainMode one of raise, lower, flatten, meadow, beach, dirt, rock, snow, flowers. Or use action \"moveAsset\" with targetId plus dx and dz between -4 and 4. Or use action \"rotateAsset\" with targetId plus rotation between -1 and 1 radians. Or use action \"scaleAsset\" with targetId plus scaleMultiplier between 0.65 and 1.5. Or use action \"moveAssetToWater\" with targetId. Do not repeat existing generated objects. The speech should be one short in-character sentence said aloud before you act.",
        },
        {
          role: "user",
          content: [
            `Agent: ${agent.name}, ${agent.epithet}`,
            `Goal: ${agent.goal}`,
            `Current perception:\n${perception}`,
            `Current generated count: ${generated.length}`,
            `Recent objects:\n${recentObjects || "none yet"}`,
            `Controllable object ids:\n${controllableObjects || "none yet"}`,
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

export async function askAgentForReply(
  agent: TellusAgent,
  message: string,
  generated: GeneratedThing[],
  logs: TellusLog[],
  visualFeedback: string,
): Promise<string> {
  const perception = describeAgentPerception(agent, generated, logs, visualFeedback);
  const recentObjects = generated
    .slice(-10)
    .map((thing) => `${thing.kind}: ${thing.prompt}`)
    .join("\n");
  const recentLogs = logs
    .slice(-10)
    .map((log) => `${log.agentName}: ${log.text}`)
    .join("\n");
  const response = await fetch(tellusApiUrl("/api/chat"), {
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
            `Current perception:\n${perception}`,
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
