import { DurableObject } from "cloudflare:workers";
import {
  type QueuedGenerationJob,
  type TellusTerrainState,
  type WorldAction,
  type WorldGeneratedThing,
  type WorldPatch,
  type WorldPresence,
  isTellusTerrainState,
  isWorldGeneratedThing,
  isWorldAction,
} from "../src/world-protocol";

interface Env {
  TELLUS_WORLD: DurableObjectNamespace<TellusWorld>;
  TELLUS_GENERATION_QUEUE?: Queue<QueuedGenerationJob>;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const assetLibraryBaseUrl = "https://3d.flobots.xyz";
const presenceTtlMs = 90_000;

const defaultTerrainState = (): TellusTerrainState => ({
  version: 2,
  revision: 0,
  terrainSculptOffsets: [],
  terrainPaint: [],
  distantIslandSculptOffsets: {},
  distantIslandPaint: {},
  savedAt: new Date(0).toISOString(),
});

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...corsHeaders,
      ...init?.headers,
    },
  });
}

function emptyCorsResponse(init?: ResponseInit): Response {
  return new Response(null, {
    ...init,
    headers: {
      ...corsHeaders,
      ...init?.headers,
    },
  });
}

function worldIdFromPath(pathname: string): { worldId: string; route: string } | null {
  const match = /^\/api\/world\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    worldId: decodeURIComponent(match[1]),
    route: match[2] ?? "state",
  };
}

async function assetLibraryResponse(request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return emptyCorsResponse({ status: 405 });
  }

  if (pathname === "/api/assets/models") {
    const upstream = new URL("/api/models", assetLibraryBaseUrl);
    for (const key of ["page", "per_page", "search", "user_only"]) {
      const value = url.searchParams.get(key);
      if (value !== null) upstream.searchParams.set(key, value);
    }
    const response = await fetch(upstream);
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        ...corsHeaders,
      },
    });
  }

  const downloadMatch = /^\/api\/assets\/download\/([^/]+)$/.exec(pathname);
  if (downloadMatch) {
    const response = await fetch(`${assetLibraryBaseUrl}/download/${encodeURIComponent(downloadMatch[1])}`);
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("Content-Type") ?? "model/gltf-binary",
        ...corsHeaders,
      },
    });
  }

  return emptyCorsResponse({ status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return emptyCorsResponse({ status: 204 });
    }
    if (url.pathname.startsWith("/api/assets/")) {
      return assetLibraryResponse(request, url.pathname);
    }
    const target = worldIdFromPath(url.pathname);
    if (!target) {
      return emptyCorsResponse({ status: 404 });
    }

    const id = env.TELLUS_WORLD.idFromName(target.worldId);
    const stub = env.TELLUS_WORLD.get(id);
    return stub.fetch(request);
  },
};

export class TellusWorld extends DurableObject<Env> {
  private worldId = "main";
  private terrain: TellusTerrainState | null = null;
  private presence = new Map<string, WorldPresence>();
  private generated = new Map<string, WorldGeneratedThing>();
  private queuedGenerationJobs = new Map<string, QueuedGenerationJob>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = worldIdFromPath(url.pathname);
    if (target) this.worldId = target.worldId;

    if (request.method === "OPTIONS") {
      return emptyCorsResponse({ status: 204 });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptWebSocket(request);
    }

    if (request.method === "GET") {
      return jsonResponse(await this.snapshot());
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!isWorldAction(body)) {
        return jsonResponse({ error: "Invalid Tellus world action" }, { status: 400 });
      }
      return jsonResponse(await this.applyAction(body));
    }

    return emptyCorsResponse({ status: 405 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const action = JSON.parse(message) as unknown;
    if (!isWorldAction(action)) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid Tellus world action" }));
      return;
    }
    const patch = await this.applyAction(action);
    this.broadcast(patch);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const visitorId = ws.deserializeAttachment()?.visitorId;
    if (typeof visitorId === "string") {
      this.presence.delete(visitorId);
      await this.persistPresence();
      this.broadcast({ type: "presence.updated", presence: [...this.presence.values()] });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async acceptWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const url = new URL(request.url);
    const visitorId =
      url.searchParams.get("visitorId") || crypto.randomUUID();
    const now = new Date().toISOString();
    this.presence.set(visitorId, {
      visitorId,
      connectedAt: now,
      lastSeenAt: now,
    });
    server.serializeAttachment({ visitorId });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(await this.snapshot()));
    this.broadcast({ type: "presence.updated", presence: [...this.presence.values()] });
    await this.persistPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async snapshot(): Promise<WorldPatch> {
    await this.loadState();
    await this.prunePresence();
    return {
      type: "world.snapshot",
      worldId: this.worldId,
      terrain: this.terrain ?? defaultTerrainState(),
      presence: [...this.presence.values()],
      generated: [...this.generated.values()],
      queuedGenerationJobs: [...this.queuedGenerationJobs.values()],
    };
  }

  private async applyAction(action: WorldAction): Promise<WorldPatch> {
    await this.loadState();
    await this.prunePresence();
    const now = new Date().toISOString();

    if (action.type === "presence.update") {
      const existing = this.presence.get(action.visitorId);
      this.presence.set(action.visitorId, {
        visitorId: action.visitorId,
        name: action.name ?? existing?.name,
        position: action.position ?? existing?.position,
        connectedAt: existing?.connectedAt ?? now,
        lastSeenAt: now,
      });
      await this.persistPresence();
      return { type: "presence.updated", presence: [...this.presence.values()] };
    }

    if (action.type === "terrain.replace") {
      this.terrain = {
        ...action.terrain,
        revision: Math.max((this.terrain?.revision ?? 0) + 1, action.terrain.revision),
        savedAt: now,
      };
      await this.ctx.storage.put("terrain", this.terrain);
      return {
        type: "terrain.updated",
        terrain: this.terrain,
        actorId: action.visitorId,
      };
    }

    if (action.type === "generation.request") {
      const job: QueuedGenerationJob = {
        id: crypto.randomUUID(),
        worldId: this.worldId,
        request: action.request,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      this.queuedGenerationJobs.set(job.id, job);
      await this.ctx.storage.put("queuedGenerationJobs", [...this.queuedGenerationJobs.values()]);
      await this.env.TELLUS_GENERATION_QUEUE?.send(job);
      return { type: "generation.queued", job };
    }

    if (action.type === "generated.upsert") {
      const thing = {
        ...action.thing,
        updatedAt: now,
      };
      this.generated.set(thing.id, thing);
      await this.ctx.storage.put("generated", [...this.generated.values()]);
      return { type: "generated.updated", thing, actorId: action.visitorId };
    }

    if (action.type === "generated.delete") {
      this.generated.delete(action.id);
      await this.ctx.storage.put("generated", [...this.generated.values()]);
      return { type: "generated.deleted", id: action.id, actorId: action.visitorId };
    }

    return {
      type: "action.rejected",
      actionType: action.type,
      reason: "Server-authoritative sculpt actions are not implemented yet. Send terrain.replace snapshots for now.",
    };
  }

  private async loadState(): Promise<void> {
    if (!this.terrain) {
      const terrain = await this.ctx.storage.get<TellusTerrainState>("terrain");
      this.terrain = isTellusTerrainState(terrain) ? terrain : defaultTerrainState();
    }
    if (this.presence.size === 0) {
      const presence = await this.ctx.storage.get<WorldPresence[]>("presence");
      if (Array.isArray(presence)) {
        this.presence = new Map(presence.map((item) => [item.visitorId, item]));
      }
    }
    if (this.queuedGenerationJobs.size === 0) {
      const jobs = await this.ctx.storage.get<QueuedGenerationJob[]>("queuedGenerationJobs");
      if (Array.isArray(jobs)) {
        this.queuedGenerationJobs = new Map(jobs.map((item) => [item.id, item]));
      }
    }
    if (this.generated.size === 0) {
      const generated = await this.ctx.storage.get<WorldGeneratedThing[]>("generated");
      if (Array.isArray(generated)) {
        this.generated = new Map(
          generated.filter(isWorldGeneratedThing).map((item) => [item.id, item]),
        );
      }
    }
  }

  private async persistPresence(): Promise<void> {
    await this.ctx.storage.put("presence", [...this.presence.values()]);
  }

  private async prunePresence(): Promise<boolean> {
    const now = Date.now();
    let pruned = false;
    for (const [visitorId, presence] of this.presence) {
      const lastSeenAt = Date.parse(presence.lastSeenAt);
      if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > presenceTtlMs) {
        this.presence.delete(visitorId);
        pruned = true;
      }
    }
    if (pruned) {
      await this.persistPresence();
      this.broadcast({ type: "presence.updated", presence: [...this.presence.values()] });
    }
    return pruned;
  }

  private broadcast(patch: WorldPatch): void {
    const payload = JSON.stringify(patch);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }
}
