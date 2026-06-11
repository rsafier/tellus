import * as THREE from "three";
import {
  POND_RADIUS,
  SEA_LEVEL,
  OCEAN_RADIUS,
  setWorldScale,
  worldScaleForId,
} from "./tellus-constants";
import {
  applyTellusTerrainState,
  pondWaterLevel,
  rebuildDistantIslandSpecs,
} from "./tellus-terrain";
import { POND_CENTER } from "./tellus-constants";
import {
  createFallbackOceanMaterial,
  createTerrainGeometry,
  loadGeneratedModel,
} from "./tellus-scene-builders";
import { loadRuntimeConfig, runtimeConfig } from "./tellus-runtime-config";
import type { GeneratedThing, Vec3 } from "./tellus-types";

// ── Agent-view: the headless eye ─────────────────────────────────────────────────────────────────
// A MINIMAL world renderer for the shared browser-driver container: terrain + placed things +
// presence markers, fixed daylight, NO UI / React / P2P / vegetation / physics / day-night. It polls
// the world's HTTP /state (no /live socket, so no ghost presence) and renders at ~2fps just to keep
// assets warm. One page serves EVERY agent in the world:
//
//   window.agentView.captureFor(visitorId, w?, h?) -> JPEG data URL of that visitor's first-person view
//
// Hyades' view-session grain opens ONE of these per world via the browser-driver (POST /sessions
// {gameUrl: .../agent-view.html?world=X}) and asks for per-agent captures — server-side sight for
// offline agents, without rendering the full game.

const params = new URLSearchParams(location.search);
const worldId = (params.get("world") || "main").trim();

interface StatePresence {
  visitorId?: string;
  position?: Vec3;
  name?: string;
}

interface WorldStateSnapshot {
  presence?: StatePresence[];
  generated?: Array<Record<string, unknown>>;
  terrain?: unknown;
}

let latestPresence: StatePresence[] = [];
let terrainRevision = -1;
let ready = false;

const boot = async () => {
  await loadRuntimeConfig().catch(() => undefined);
  runtimeConfig.worldId = worldId;
  setWorldScale(worldScaleForId(worldId));
  rebuildDistantIslandSpecs();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa7c3ef);
  scene.fog = new THREE.Fog(0xa7c3ef, 72, 260);

  const sun = new THREE.DirectionalLight(0xffdfb7, 3.6);
  sun.position.set(-55, 70, 42);
  const hemi = new THREE.HemisphereLight(0xb6ccff, 0x3d5332, 2.1);
  scene.add(sun, hemi);

  const terrain = new THREE.Mesh(
    createTerrainGeometry(144),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
  );
  scene.add(terrain);

  const ocean = new THREE.Mesh(new THREE.CircleGeometry(OCEAN_RADIUS, 96), createFallbackOceanMaterial());
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = SEA_LEVEL;
  scene.add(ocean);

  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(POND_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: 0x6fb7d7, transparent: true, opacity: 0.55 }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(POND_CENTER.x, pondWaterLevel(), POND_CENTER.z);
  scene.add(pond);

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(64, 64, false);

  const povCamera = new THREE.PerspectiveCamera(62, 256 / 144, 0.1, 720);

  // ── generated things (diffed by id + modelUrl/scale) ──
  const meshes = new Map<string, { mesh: THREE.Object3D; key: string }>();
  let loading = 0;
  const syncThings = (things: Array<Record<string, unknown>>) => {
    const wanted = new Set<string>();
    for (const raw of things) {
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id) continue;
      wanted.add(id);
      const thing = raw as unknown as GeneratedThing;
      const key = `${thing.modelUrl ?? ""}:${thing.scale ?? 1}`;
      const existing = meshes.get(id);
      if (existing && existing.key === key) {
        // cheap transform refresh
        existing.mesh.position.set(thing.position?.x ?? 0, thing.position?.y ?? 0, thing.position?.z ?? 0);
        existing.mesh.rotation.set(thing.rotationX ?? 0, thing.rotationY ?? 0, thing.rotationZ ?? 0);
        continue;
      }
      if (existing) {
        scene.remove(existing.mesh);
        meshes.delete(id);
      }
      if (!thing.modelUrl || loading > 5) {
        // placeholder blob (also used while the GLB streams in)
        const blob = new THREE.Mesh(
          new THREE.IcosahedronGeometry(Math.max(0.4, (thing.scale ?? 1) * 0.6), 0),
          new THREE.MeshStandardMaterial({ color: thing.color ?? 0x888888, roughness: 0.85 }),
        );
        blob.position.set(thing.position?.x ?? 0, (thing.position?.y ?? 0) + 0.5, thing.position?.z ?? 0);
        scene.add(blob);
        meshes.set(id, { mesh: blob, key });
        continue;
      }
      loading++;
      const placeholder = new THREE.Group();
      scene.add(placeholder);
      meshes.set(id, { mesh: placeholder, key });
      void loadGeneratedModel(thing.modelUrl, thing)
        .then((model) => {
          const cur = meshes.get(id);
          if (!cur || cur.key !== key) return;
          scene.remove(cur.mesh);
          scene.add(model);
          meshes.set(id, { mesh: model, key });
        })
        .catch(() => undefined)
        .finally(() => {
          loading--;
        });
    }
    for (const [id, entry] of meshes) {
      if (!wanted.has(id)) {
        scene.remove(entry.mesh);
        meshes.delete(id);
      }
    }
  };

  // ── presence markers (simple capsules — enough for "someone is there") ──
  const presenceMeshes = new Map<string, THREE.Mesh>();
  const presenceMaterial = new THREE.MeshStandardMaterial({ color: 0x8fb4e0, roughness: 0.7 });
  const syncPresence = (presence: StatePresence[]) => {
    latestPresence = presence;
    const wanted = new Set<string>();
    for (const p of presence) {
      if (!p.visitorId) continue;
      wanted.add(p.visitorId);
      let mesh = presenceMeshes.get(p.visitorId);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.5, 3, 8), presenceMaterial);
        scene.add(mesh);
        presenceMeshes.set(p.visitorId, mesh);
      }
      mesh.position.set(p.position?.x ?? 0, (p.position?.y ?? 0) + 1.2, p.position?.z ?? 0);
    }
    for (const [id, mesh] of presenceMeshes) {
      if (!wanted.has(id)) {
        scene.remove(mesh);
        presenceMeshes.delete(id);
      }
    }
  };

  // ── state polling (HTTP only — no /live, so no ghost presence in the world) ──
  const poll = async () => {
    try {
      const res = await fetch(
        `${runtimeConfig.worldApiBase}/api/world/${encodeURIComponent(worldId)}/state?userId=agent-view`,
      );
      if (!res.ok) return;
      const snapshot = (await res.json()) as WorldStateSnapshot;
      if (Array.isArray(snapshot.generated)) syncThings(snapshot.generated);
      if (Array.isArray(snapshot.presence)) syncPresence(snapshot.presence);
      const terrainState = snapshot.terrain as { revision?: number } | undefined;
      if (terrainState && typeof terrainState.revision === "number" && terrainState.revision !== terrainRevision) {
        terrainRevision = terrainState.revision;
        try {
          applyTellusTerrainState(terrainState as never);
          terrain.geometry.dispose();
          terrain.geometry = createTerrainGeometry(144);
          pond.position.y = pondWaterLevel();
        } catch {
          /* keep the old terrain on a parse hiccup */
        }
      }
      ready = true;
    } catch {
      /* transient — keep last state */
    }
  };
  await poll();
  setInterval(() => void poll(), 5000);

  // warm render at ~2fps (uploads textures/geometry so captures are instant)
  const warmCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 720);
  warmCamera.position.set(0, 60, 80);
  warmCamera.lookAt(0, 0, 0);
  setInterval(() => {
    try {
      renderer.setSize(64, 64, false);
      renderer.render(scene, warmCamera);
    } catch {
      /* ignore */
    }
  }, 500);

  // ── the capture API the browser-driver calls ──
  const captureFor = async (visitorId: string, w = 256, h = 144): Promise<string | null> => {
    const p = latestPresence.find((x) => x.visitorId === visitorId);
    if (!p?.position) return null;
    povCamera.aspect = w / h;
    povCamera.updateProjectionMatrix();
    const eye = new THREE.Vector3(p.position.x, p.position.y + 2.4, p.position.z);
    // face the island center-ish (presence carries no heading) with a slight downward tilt
    const look = new THREE.Vector3(-p.position.x * 0.2, p.position.y + 0.6, -p.position.z * 0.2);
    if (eye.distanceTo(look) < 2) look.set(eye.x + 6, eye.y - 1.2, eye.z);
    povCamera.position.copy(eye);
    povCamera.lookAt(look);
    canvas.width = w;
    canvas.height = h;
    renderer.setSize(w, h, false);
    renderer.render(scene, povCamera);
    return canvas.toDataURL("image/jpeg", 0.6);
  };

  (window as unknown as { agentView: object }).agentView = {
    get ready() {
      return ready;
    },
    worldId,
    captureFor,
  };
};

void boot();
