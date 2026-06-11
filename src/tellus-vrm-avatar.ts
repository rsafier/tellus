// Rigged VRM robot avatars (asset-store VRMs + retargetable VRMA clips) that upgrade the
// procedural TV-head robots from world-builders.ts IN PLACE. The sync entry points
// (createVisitorMesh/createRemoteVisitorMesh) stay untouched — attachVrmAvatar() is the async
// upgrade: it loads a deterministic-per-visitor VRM, hides the procedural body parts (NEVER the
// TV screen — P2P video keeps riding `group.userData.tvScreenRef`), mounts the rigged robot under
// the same group and floats the TV + presence ring above its head. ANY failure leaves the
// procedural avatar untouched (zero regression); localStorage "tellus.classicAvatar"="1" skips
// VRM entirely.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  MToonMaterialLoaderPlugin,
  VRMLoaderPlugin,
  VRMUtils,
  type VRM,
} from "@pixiv/three-vrm";
import { MToonNodeMaterial } from "@pixiv/three-vrm/nodes";
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import { runtimeConfig } from "./tellus-runtime-config";

// ── Asset-store ids (the ONLY thing to touch when new avatars/clips land) ──────────────────────
// All are plain GETs on the header-free /api/assets proxy (no session header on purpose).
export const AVATAR_IDS: readonly string[] = [
  "6a211f7d90ef2a93f06a262b", // Bluebot
  "6a211fb8cf0cffae65faf147", // Blue
  "6a211fda90ef2a93f06a2640", // Blue Atlantean
];

export type RigClipName = "idle" | "walk" | "jump" | "wave";

// There is no jump VRMA in the store yet — when one lands, set CLIP_IDS.jump and the rig uses it
// automatically (until then airborne holds the walk clip mid-stride; see enterAirborne()).
export const CLIP_IDS: Record<RigClipName, string | undefined> = {
  idle: "6a20d88a90ef2a93f06a2037", // Idle
  walk: "6a20d93d90ef2a93f06a2049", // Walking
  jump: undefined,
  wave: "6a20d72890ef2a93f06a2027", // Stand Up and Wave
};

// Locomotion tuning. Speeds are world units/sec (player walk speed is ~13–19 depending on world
// scale); hysteresis keeps remote avatars (fed by ~300ms presence deltas) from flickering.
const WALK_ENTER_SPEED = 1.6;
const WALK_EXIT_SPEED = 0.7;
const WALK_CLIP_REFERENCE_SPEED = 7;
const WALK_TIMESCALE_MIN = 0.7;
const WALK_TIMESCALE_MAX = 1.9;
const TELEPORT_SPEED = 50; // presence jumps faster than this are teleports, not walking
const REMOTE_SPEED_HOLD_MS = 700; // keep walking this long past the last presence delta
const REMOTE_AIRBORNE_MS = 450; // vertical presence spike → brief airborne
const REMOTE_AIRBORNE_DY = 1.05;
// The VRM body takes this share of the procedural robot's body height; the TV + ring float above,
// so the overall silhouette height stays ≈ the old avatar.
const VRM_BODY_HEIGHT_RATIO = 0.72;

export interface AvatarRig {
  root: THREE.Group;
  vrm: VRM;
  mixer: THREE.AnimationMixer;
  actions: Record<RigClipName, THREE.AnimationAction | undefined>;
  /** Crossfade to a clip (no-op when the clip is missing or already current). */
  play(name: RigClipName, fadeSec?: number): void;
  /** Horizontal speed in world units/sec — drives walk/idle (with hysteresis + clip timescale). */
  setMoving(speed: number): void;
  setAirborne(airborne: boolean): void;
  /** Feed a remote presence target — derives speed/airborne from successive update deltas. */
  notePresenceUpdate(x: number, y: number, z: number, nowMs: number): void;
  /** Advance mixer + VRM (spring bones, normalized→raw bone copy). Call once per frame. */
  update(dt: number): void;
  dispose(): void;
}

export function classicAvatarRequested(): boolean {
  try {
    return window.localStorage.getItem("tellus.classicAvatar") === "1";
  } catch {
    return false;
  }
}

function assetDownloadUrl(id: string): string {
  return `${runtimeConfig.worldApiBase}/api/assets/download/${encodeURIComponent(id)}`;
}

/** Stable FNV-1a hash → each visitorId (players AND agent:* ids) always gets the same robot. */
export function pickAvatarId(visitorId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < visitorId.length; i++) {
    h ^= visitorId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return AVATAR_IDS[(h >>> 0) % AVATAR_IDS.length];
}

// ── Loaders + caches ────────────────────────────────────────────────────────────────────────────
// VRM binaries are cached as ArrayBuffers (parse per avatar instance — skinned scenes can't be
// shared); parsed VRMAnimations are cached per clip URL (retarget per avatar is cheap).
const vrmBufferCache = new Map<string, Promise<ArrayBuffer>>();
const vrmaCache = new Map<string, Promise<VRMAnimation>>();
let warnedVrmLoadFailure = false;

function makeVrmLoader(rendererIsWebGPU: boolean): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register(
    (parser) =>
      new VRMLoaderPlugin(
        parser,
        // MToon's WebGL shader doesn't compile under WebGPURenderer — swap in the node-material
        // implementation there (three-vrm ships it for exactly this; standard PBR VRMs are
        // unaffected either way).
        rendererIsWebGPU
          ? {
              mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
                materialType: MToonNodeMaterial,
              }),
            }
          : undefined,
      ),
  );
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return loader;
}

function fetchAssetBuffer(url: string): Promise<ArrayBuffer> {
  let pending = vrmBufferCache.get(url);
  if (!pending) {
    pending = (async () => {
      // Deliberately a bare fetch: /api/assets/* is the header-free proxy path.
      const response = await fetch(url);
      if (!response.ok) throw new Error(`asset fetch ${response.status}`);
      return response.arrayBuffer();
    })();
    pending.catch(() => vrmBufferCache.delete(url)); // failed fetches retry next time
    vrmBufferCache.set(url, pending);
  }
  return pending;
}

export async function loadVrm(url: string, rendererIsWebGPU: boolean): Promise<VRM> {
  const buffer = await fetchAssetBuffer(url);
  const gltf = await makeVrmLoader(rendererIsWebGPU).parseAsync(buffer, "");
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("file is not a VRM");
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // VRM0 → face the same way as VRM1 (+Z, the group's forward)
  if (vrm.lookAt) {
    // createVRMAnimationClip wants this proxy; creating it up front avoids a per-clip warning.
    const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    lookAtProxy.name = "VRMLookAtQuaternionProxy";
    vrm.scene.add(lookAtProxy);
  }
  vrm.scene.traverse((obj) => {
    // Animated skinned meshes sweep outside their rest-pose bounds — never frustum-cull them.
    obj.frustumCulled = false;
  });
  return vrm;
}

function loadVrmaAnimation(url: string, rendererIsWebGPU: boolean): Promise<VRMAnimation> {
  let pending = vrmaCache.get(url);
  if (!pending) {
    pending = (async () => {
      const buffer = await fetchAssetBuffer(url);
      const gltf = await makeVrmLoader(rendererIsWebGPU).parseAsync(buffer, "");
      const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
      if (!animations?.length) throw new Error("file has no VRM animation");
      return animations[0];
    })();
    pending.catch(() => vrmaCache.delete(url));
    vrmaCache.set(url, pending);
  }
  return pending;
}

async function loadOptionalClip(
  id: string | undefined,
  rendererIsWebGPU: boolean,
): Promise<VRMAnimation | undefined> {
  if (!id) return undefined;
  try {
    return await loadVrmaAnimation(assetDownloadUrl(id), rendererIsWebGPU);
  } catch {
    return undefined; // a missing optional clip never blocks the avatar
  }
}

// ── The rig (state machine: idle ⇄ walk, + airborne hold) ──────────────────────────────────────
class VrmAvatarRig implements AvatarRig {
  root: THREE.Group;
  vrm: VRM;
  mixer: THREE.AnimationMixer;
  actions: Record<RigClipName, THREE.AnimationAction | undefined>;

  private current: RigClipName | undefined;
  private airborne = false;
  private smoothedSpeed = 0;
  private walking = false;
  // Remote-presence inference (only used when notePresenceUpdate is being fed).
  private remoteDriven = false;
  private lastTarget = new THREE.Vector3();
  private lastTargetAtMs = 0;
  private remoteSpeed = 0;
  private remoteSpeedUntilMs = 0;
  private remoteAirborneUntilMs = 0;
  private disposed = false;

  constructor(root: THREE.Group, vrm: VRM, clips: Partial<Record<RigClipName, VRMAnimation>>) {
    this.root = root;
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = { idle: undefined, walk: undefined, jump: undefined, wave: undefined };
    for (const name of ["idle", "walk", "jump", "wave"] as const) {
      const animation = clips[name];
      if (!animation) continue;
      const clip = createVRMAnimationClip(animation, vrm);
      clip.name = name;
      this.actions[name] = this.mixer.clipAction(clip);
    }
    this.play("idle", 0);
  }

  play(name: RigClipName, fadeSec = 0.25): void {
    const next = this.actions[name];
    if (!next || this.current === name) return;
    const prev = this.current ? this.actions[this.current] : undefined;
    next.reset();
    next.setEffectiveWeight(1);
    if (fadeSec > 0 && prev) {
      prev.fadeOut(fadeSec);
      next.fadeIn(fadeSec);
    } else {
      prev?.stop();
    }
    next.play();
    this.current = name;
  }

  setMoving(speed: number): void {
    if (this.disposed) return;
    // Light smoothing + enter/exit hysteresis so frame jitter / presence cadence can't flicker.
    this.smoothedSpeed += (speed - this.smoothedSpeed) * 0.3;
    const wasWalking = this.walking;
    this.walking = wasWalking
      ? this.smoothedSpeed > WALK_EXIT_SPEED
      : this.smoothedSpeed > WALK_ENTER_SPEED;
    if (!this.airborne && this.walking !== wasWalking) {
      this.play(this.walking ? "walk" : "idle");
    }
  }

  setAirborne(airborne: boolean): void {
    if (this.disposed || airborne === this.airborne) return;
    this.airborne = airborne;
    if (airborne) this.enterAirborne();
    else this.exitAirborne();
  }

  notePresenceUpdate(x: number, y: number, z: number, nowMs: number): void {
    if (this.disposed) return;
    if (this.remoteDriven && this.lastTargetAtMs > 0) {
      const dtSec = Math.max(0.05, (nowMs - this.lastTargetAtMs) / 1000);
      const dx = x - this.lastTarget.x;
      const dy = y - this.lastTarget.y;
      const dz = z - this.lastTarget.z;
      const hSpeed = Math.hypot(dx, dz) / dtSec;
      if (hSpeed < TELEPORT_SPEED) {
        this.remoteSpeed = hSpeed;
        this.remoteSpeedUntilMs = nowMs + REMOTE_SPEED_HOLD_MS;
        if (Math.abs(dy) > REMOTE_AIRBORNE_DY) {
          this.remoteAirborneUntilMs = nowMs + REMOTE_AIRBORNE_MS;
        }
      } else {
        this.remoteSpeed = 0;
        this.remoteSpeedUntilMs = 0;
      }
    }
    this.remoteDriven = true;
    this.lastTarget.set(x, y, z);
    this.lastTargetAtMs = nowMs;
  }

  update(dt: number): void {
    if (this.disposed) return;
    if (this.remoteDriven) {
      const now = performance.now();
      this.setAirborne(now < this.remoteAirborneUntilMs);
      this.setMoving(now < this.remoteSpeedUntilMs ? this.remoteSpeed : 0);
    }
    const walk = this.actions.walk;
    if (walk && this.current === "walk" && !this.airborne) {
      walk.timeScale = THREE.MathUtils.clamp(
        this.smoothedSpeed / WALK_CLIP_REFERENCE_SPEED,
        WALK_TIMESCALE_MIN,
        WALK_TIMESCALE_MAX,
      );
    }
    this.mixer.update(dt);
    this.vrm.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.vrm.scene);
    this.vrm.scene.parent?.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
  }

  // No jump VRMA yet: hold the walk clip mid-stride while airborne (reads as a leap); falls back
  // to idle if even the walk clip is missing. A real jump clip (CLIP_IDS.jump) takes over as soon
  // as one is configured.
  private enterAirborne(): void {
    if (this.actions.jump) {
      this.play("jump", 0.1);
      return;
    }
    const walk = this.actions.walk;
    if (walk) {
      this.play("walk", 0.12);
      walk.time = walk.getClip().duration * 0.3; // mid-stride pose
      walk.paused = true;
      walk.timeScale = 1;
    } else {
      this.play("idle", 0.12);
    }
  }

  private exitAirborne(): void {
    const walk = this.actions.walk;
    if (walk) walk.paused = false;
    // Land into whatever locomotion currently calls for.
    this.play(this.walking ? "walk" : "idle", 0.15);
  }
}

// ── Mounting: swap the procedural body for the VRM inside the existing group ───────────────────
function localTopOf(parts: THREE.Object3D[]): number {
  let top = 0;
  for (const part of parts) {
    if (!(part instanceof THREE.Mesh)) continue;
    const geometry = part.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) continue;
    top = Math.max(top, box.max.y * part.scale.y + part.position.y);
  }
  return top;
}

function mountVrmOnAvatar(group: THREE.Group, vrm: VRM): void {
  const bodyParts = (group.userData.robotBodyParts as THREE.Object3D[] | undefined) ?? [];
  const tvBox = group.userData.tvBoxRef as THREE.Object3D | undefined;
  const screen = group.userData.tvScreenRef as THREE.Mesh | undefined;
  const marker = group.userData.markerRef as THREE.Object3D | undefined;

  // Measure the procedural robot (feet→TV-top) so the upgraded avatar keeps the same height.
  const bodyTop = Math.max(1, localTopOf(tvBox ? [...bodyParts, tvBox] : bodyParts));

  vrm.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  const rawHeight = Math.max(0.01, bounds.max.y - bounds.min.y);
  const targetHeight = bodyTop * VRM_BODY_HEIGHT_RATIO;
  const scale = targetHeight / rawHeight;
  vrm.scene.scale.setScalar(scale);
  vrm.scene.position.y = -bounds.min.y * scale; // feet on the group origin, like the old robot

  group.add(vrm.scene);
  group.updateMatrixWorld(true);

  // Float the TV (and its screen — P2P video keeps working untouched) above the VRM's head.
  let headTopY = targetHeight;
  const head = vrm.humanoid?.getNormalizedBoneNode("head");
  if (head) {
    const headPos = head.getWorldPosition(new THREE.Vector3());
    group.worldToLocal(headPos);
    headTopY = Math.max(headTopY, headPos.y + 0.35);
  }
  const tvCenterY = headTopY + 0.5;
  if (tvBox) tvBox.position.y = tvCenterY;
  if (screen) screen.position.y = tvCenterY; // keeps its +Z offset flush on the TV front
  if (marker) marker.position.y = tvCenterY + 0.65;

  for (const part of bodyParts) part.visible = false;
}

/**
 * Upgrade a procedural TV-head avatar group to a rigged VRM robot. Resolves null (procedural
 * avatar untouched) when: the classic escape hatch is set, no API base is configured, or anything
 * about the load fails. idle+walk clips are required; wave/jump are best-effort.
 */
export async function attachVrmAvatar(
  group: THREE.Group,
  visitorId: string,
  rendererIsWebGPU: boolean,
): Promise<AvatarRig | null> {
  if (classicAvatarRequested()) return null;
  if (!runtimeConfig.worldApiBase) return null;
  try {
    const [vrm, idle, walk, jump, wave] = await Promise.all([
      loadVrm(assetDownloadUrl(pickAvatarId(visitorId)), rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.idle, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.walk, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.jump, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.wave, rendererIsWebGPU),
    ]);
    if (!idle || !walk) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error("idle/walk animation clips unavailable");
    }
    mountVrmOnAvatar(group, vrm);
    return new VrmAvatarRig(group, vrm, { idle, walk, jump, wave });
  } catch (error) {
    if (!warnedVrmLoadFailure) {
      warnedVrmLoadFailure = true;
      console.warn(
        "[avatar] VRM avatar load failed — keeping the classic TV-head robot",
        error,
      );
    }
    return null;
  }
}
