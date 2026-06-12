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

// ── User avatar scale (the picker "Size" slider) ────────────────────────────────────────────────
// VISUAL-ONLY: scales the avatar silhouette (mounted model / classic TV-head body + TV/ring
// offsets) inside the visitor group — physics, collision and movement are deliberately untouched.
// The whole group is NOT scaled (its world position is written every frame by the position code,
// and other children — selection helpers etc. — must not inherit the scale); instead every avatar
// node keeps a captured scale-1 baseline (position + scale) and the user factor multiplies both,
// so the silhouette scales coherently around the feet at the group origin. Bounds mirror the
// server-side clamp on presence.avatarScale.
export const AVATAR_SCALE_MIN = 0.1;
export const AVATAR_SCALE_MAX = 8;

/** Clamp to the legal user-scale range; anything non-finite / non-positive means "unset" → 1. */
export function clampAvatarScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return THREE.MathUtils.clamp(value, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX);
}

interface AvatarScaleState {
  current: number;
  target: number;
  /** Scale-1 baseline per managed node — recaptured whenever layout code (mount/restore) re-seats
   * everything at base scale. */
  bases: Map<THREE.Object3D, { position: THREE.Vector3; scale: THREE.Vector3 }>;
}

function avatarScaleState(group: THREE.Group): AvatarScaleState {
  let state = group.userData.avatarScaleState as AvatarScaleState | undefined;
  if (!state) {
    state = { current: 1, target: 1, bases: new Map() };
    group.userData.avatarScaleState = state;
  }
  return state;
}

function applyAvatarScaleFactor(group: THREE.Group, factor: number): void {
  const state = avatarScaleState(group);
  for (const [node, base] of state.bases) {
    if (node.parent !== group) continue; // disposed/replaced nodes simply drop out
    node.position.copy(base.position).multiplyScalar(factor);
    node.scale.copy(base.scale).multiplyScalar(factor);
  }
}

/** Every group child the user scale manages: classic body parts, TV box + screen, presence ring
 * and (when mounted) the rigged model. */
function avatarScaledNodes(group: THREE.Group): THREE.Object3D[] {
  const nodes: THREE.Object3D[] = [
    ...((group.userData.robotBodyParts as THREE.Object3D[] | undefined) ?? []),
  ];
  for (const key of ["tvBoxRef", "tvScreenRef", "markerRef", "avatarMountedModel"] as const) {
    const node = group.userData[key] as THREE.Object3D | undefined;
    if (node) nodes.push(node);
  }
  return nodes;
}

/** Re-seat layout code runs at scale 1 — call this FIRST so measurements (and the once-only
 * classic-layout capture) see the true baseline, then rebaseAvatarScale() afterwards. */
function resetAvatarScaleToBase(group: THREE.Group): void {
  applyAvatarScaleFactor(group, 1);
}

/** Recapture the scale-1 baseline AFTER mount/restore seated everything, then re-apply the
 * group's current user scale on top. */
function rebaseAvatarScale(group: THREE.Group): void {
  const state = avatarScaleState(group);
  state.bases.clear();
  for (const node of avatarScaledNodes(group)) {
    state.bases.set(node, { position: node.position.clone(), scale: node.scale.clone() });
  }
  applyAvatarScaleFactor(group, state.current);
}

/** The currently APPLIED user scale (mid-lerp value — what the silhouette/eye height shows now). */
export function getAvatarUserScale(group: THREE.Group): number {
  return (group.userData.avatarScaleState as AvatarScaleState | undefined)?.current ?? 1;
}

/** Set the user-scale target. `immediate` snaps (initial spawn); otherwise tickAvatarScale()
 * eases toward it (~0.3s) so live remote changes don't pop. */
export function setAvatarUserScale(group: THREE.Group, scale: number, immediate = false): void {
  const state = avatarScaleState(group);
  state.target = clampAvatarScale(scale);
  if (immediate || state.bases.size === 0) {
    state.current = state.target;
    applyAvatarScaleFactor(group, state.current);
  }
}

const AVATAR_SCALE_LERP_RATE = 12; // exponential approach — visually settled in ~0.3s

/** Per-frame ease toward the target scale. No-op (zero cost) once settled. */
export function tickAvatarScale(group: THREE.Group, dt: number): void {
  const state = group.userData.avatarScaleState as AvatarScaleState | undefined;
  if (!state || state.current === state.target) return;
  const blend = 1 - Math.exp(-AVATAR_SCALE_LERP_RATE * dt);
  let next = state.current + (state.target - state.current) * blend;
  if (Math.abs(next - state.target) < 0.001 * state.target) next = state.target;
  state.current = next;
  applyAvatarScaleFactor(group, next);
}

// The rig contract main.tsx drives — implemented by BOTH the VRM robots (here) and the animated
// GLB animals (tellus-avatar-catalog.ts), so the main.tsx code paths never fork on avatar kind.
export interface AvatarRig {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<RigClipName, THREE.AnimationAction | undefined>;
  /** Crossfade to a clip (no-op when the clip is missing or already current). */
  play(name: RigClipName, fadeSec?: number): void;
  /** Play an emote clip ONCE over locomotion, then resume walk/idle. VRM rigs resolve against
   * the retargeted VRMA set ("wave", …); GLB rigs against their embedded clips by name; an
   * unknown clip is ignored. */
  playEmote(name: string): void;
  /** Horizontal speed in world units/sec — drives walk/idle (with hysteresis + clip timescale). */
  setMoving(speed: number): void;
  setAirborne(airborne: boolean): void;
  /** Feed a remote presence target — derives speed/airborne from successive update deltas. */
  notePresenceUpdate(x: number, y: number, z: number, nowMs: number): void;
  /** Advance mixer (+ VRM spring bones on the VRM path). Call once per frame. */
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

export function assetDownloadUrl(id: string): string {
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

// ── The shared rig state machine (idle ⇄ walk, + airborne hold) ────────────────────────────────
// Subclasses provide the actions (VRMA-retargeted clips for VRM robots; embedded GLB clips for the
// animals) and any per-frame extra work via afterMixerUpdate (VRM spring bones).
export abstract class LocomotionAvatarRig implements AvatarRig {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<RigClipName, THREE.AnimationAction | undefined>;

  protected current: RigClipName | undefined;
  protected airborne = false;
  protected smoothedSpeed = 0;
  protected walking = false;
  // Remote-presence inference (only used when notePresenceUpdate is being fed).
  private remoteDriven = false;
  private lastTarget = new THREE.Vector3();
  private lastTargetAtMs = 0;
  private remoteSpeed = 0;
  private remoteSpeedUntilMs = 0;
  private remoteAirborneUntilMs = 0;
  // One-shot emote overlay: while set, locomotion transitions only RECORD their target (play()
  // early-returns) and the resume happens when the mixer fires "finished" for this action.
  private emoteAction: THREE.AnimationAction | undefined;
  protected disposed = false;

  protected constructor(root: THREE.Group, mixer: THREE.AnimationMixer) {
    this.root = root;
    this.mixer = mixer;
    this.actions = { idle: undefined, walk: undefined, jump: undefined, wave: undefined };
    this.mixer.addEventListener("finished", this.onEmoteFinished);
  }

  play(name: RigClipName, fadeSec = 0.25): void {
    const next = this.actions[name];
    if (!next || this.current === name) return;
    if (this.emoteAction) {
      // Mid-emote: remember where locomotion wants to be; the emote's finish resumes there.
      this.current = name;
      return;
    }
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

  playEmote(name: string): void {
    if (this.disposed) return;
    const action = this.resolveEmoteAction(name);
    if (!action) return; // unknown clip → ignore
    // A newer emote replaces a running one mid-flight.
    if (this.emoteAction && this.emoteAction !== action) this.emoteAction.fadeOut(0.15);
    const prev = this.current ? this.actions[this.current] : undefined;
    if (prev && prev !== action) prev.fadeOut(0.2);
    this.emoteAction = action;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true; // hold the last pose so the resume crossfade has a source
    action.setEffectiveWeight(1);
    action.timeScale = 1;
    action.fadeIn(0.15);
    action.play();
  }

  /** Resolve an emote name to a playable action. Base: the rig clip set ("wave", "jump", …) by
   * exact then loose name match. GLB rigs override to search their embedded clips first. */
  protected resolveEmoteAction(name: string): THREE.AnimationAction | undefined {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return undefined;
    const direct = this.actions[wanted as RigClipName];
    if (direct) return direct;
    for (const key of Object.keys(this.actions) as RigClipName[]) {
      const action = this.actions[key];
      if (action && (wanted.includes(key) || key.includes(wanted))) return action;
    }
    return undefined;
  }

  private readonly onEmoteFinished = (event: { action: THREE.AnimationAction }) => {
    if (this.disposed || !this.emoteAction || event.action !== this.emoteAction) return;
    const action = this.emoteAction;
    this.emoteAction = undefined;
    action.fadeOut(0.2);
    // Resume whatever locomotion currently calls for (current was only recorded while emoting).
    this.current = undefined;
    if (this.airborne) this.enterAirborne();
    else this.play(this.walking ? "walk" : "idle", 0.2);
  };

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
    this.afterMixerUpdate(dt);
  }

  /** Per-frame hook after the mixer advanced (VRM spring bones / normalized→raw copy). */
  protected afterMixerUpdate(_dt: number): void {}

  abstract dispose(): void;

  // No jump clip: hold the walk clip mid-stride while airborne (reads as a leap); falls back
  // to idle if even the walk clip is missing. A real jump clip takes over as soon as one exists.
  protected enterAirborne(): void {
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

  protected exitAirborne(): void {
    const walk = this.actions.walk;
    if (walk) walk.paused = false;
    // Land into whatever locomotion currently calls for.
    this.play(this.walking ? "walk" : "idle", 0.15);
  }
}

// ── The VRM robot rig: VRMA clips retargeted onto the loaded VRM ───────────────────────────────
class VrmAvatarRig extends LocomotionAvatarRig {
  private readonly vrm: VRM;

  constructor(root: THREE.Group, vrm: VRM, clips: Partial<Record<RigClipName, VRMAnimation>>) {
    super(root, new THREE.AnimationMixer(vrm.scene));
    this.vrm = vrm;
    for (const name of ["idle", "walk", "jump", "wave"] as const) {
      const animation = clips[name];
      if (!animation) continue;
      const clip = createVRMAnimationClip(animation, vrm);
      clip.name = name;
      this.actions[name] = this.mixer.clipAction(clip);
    }
    this.play("idle", 0);
  }

  protected override afterMixerUpdate(dt: number): void {
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
}

// ── Mounting: swap the procedural body for a rigged model inside the existing group ────────────
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

interface ClassicTvLayout {
  tvY: number;
  screenY: number;
  markerY: number;
}

// Capture the procedural TV/screen/marker heights ONCE (before any mount floats them above a rigged
// model) so restoreProceduralAvatar can put the classic robot back exactly when the user swaps.
function rememberClassicLayout(group: THREE.Group): void {
  if (group.userData.classicTvLayout) return;
  const tvBox = group.userData.tvBoxRef as THREE.Object3D | undefined;
  const screen = group.userData.tvScreenRef as THREE.Mesh | undefined;
  const marker = group.userData.markerRef as THREE.Object3D | undefined;
  group.userData.classicTvLayout = {
    tvY: tvBox?.position.y ?? 2.5,
    screenY: screen?.position.y ?? 2.5,
    markerY: marker?.position.y ?? 3.0,
  } satisfies ClassicTvLayout;
}

/** Un-hide the procedural TV-head robot and re-seat the TV/screen/marker at their classic heights.
 * Safe to call on a group that was never upgraded. (Rig disposal already removed the mounted model.) */
export function restoreProceduralAvatar(group: THREE.Group): void {
  // Back to the scale-1 layout first (rig disposal already removed any mounted model); the classic
  // positions below are baseline values and the user scale re-applies via rebaseAvatarScale.
  resetAvatarScaleToBase(group);
  delete group.userData.avatarMountedModel;
  const layout = group.userData.classicTvLayout as ClassicTvLayout | undefined;
  if (layout) {
    const tvBox = group.userData.tvBoxRef as THREE.Object3D | undefined;
    const screen = group.userData.tvScreenRef as THREE.Mesh | undefined;
    const marker = group.userData.markerRef as THREE.Object3D | undefined;
    if (tvBox) tvBox.position.y = layout.tvY;
    if (screen) screen.position.y = layout.screenY;
    if (marker) marker.position.y = layout.markerY;
  }
  const bodyParts = (group.userData.robotBodyParts as THREE.Object3D[] | undefined) ?? [];
  for (const part of bodyParts) part.visible = true;
  rebaseAvatarScale(group);
}

/**
 * Mount a rigged model (VRM robot or GLB animal) inside a procedural-avatar group: scale it to
 * `heightRatio` of the robot's feet→TV-top height, ground its feet on the group origin, hide the
 * procedural body parts and float the TV + presence ring above it (the TV screen stays live —
 * P2P video keeps riding `group.userData.tvScreenRef`). `headLocalY` (computed AFTER the model is
 * added, in group-local space) lets the VRM path float the TV above the actual head bone.
 */
export function mountModelOnAvatar(
  group: THREE.Group,
  model: THREE.Object3D,
  heightRatio: number,
  headLocalY?: () => number | undefined,
): void {
  // Measure + seat everything at scale 1 (a live user scale would skew bodyTop and the once-only
  // classic-layout capture); rebaseAvatarScale at the end re-applies the user factor on the new
  // layout — so a slider move never needs a rig rebuild, and a rebuild keeps the slider value.
  resetAvatarScaleToBase(group);
  rememberClassicLayout(group);
  const bodyParts = (group.userData.robotBodyParts as THREE.Object3D[] | undefined) ?? [];
  const tvBox = group.userData.tvBoxRef as THREE.Object3D | undefined;
  const screen = group.userData.tvScreenRef as THREE.Mesh | undefined;
  const marker = group.userData.markerRef as THREE.Object3D | undefined;

  // Measure the procedural robot (feet→TV-top) so the upgraded avatar keeps a comparable height.
  const bodyTop = Math.max(1, localTopOf(tvBox ? [...bodyParts, tvBox] : bodyParts));

  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const rawHeight = Math.max(0.01, bounds.max.y - bounds.min.y);
  const targetHeight = bodyTop * heightRatio;
  const scale = targetHeight / rawHeight;
  model.scale.setScalar(scale);
  // Feet on the group origin, body centered over it (animals' rest pose can be offset on x/z).
  model.position.set(
    -((bounds.min.x + bounds.max.x) / 2) * scale,
    -bounds.min.y * scale,
    -((bounds.min.z + bounds.max.z) / 2) * scale,
  );

  group.add(model);
  group.updateMatrixWorld(true);

  // Float the TV (and its screen — P2P video keeps working untouched) above the model's head.
  let headTopY = targetHeight;
  const headY = headLocalY?.();
  if (headY !== undefined) headTopY = Math.max(headTopY, headY + 0.35);
  const tvCenterY = headTopY + 0.5;
  if (tvBox) tvBox.position.y = tvCenterY;
  if (screen) screen.position.y = tvCenterY; // keeps its +Z offset flush on the TV front
  if (marker) marker.position.y = tvCenterY + 0.65;

  for (const part of bodyParts) part.visible = false;
  group.userData.avatarMountedModel = model;
  rebaseAvatarScale(group);
}

function mountVrmOnAvatar(group: THREE.Group, vrm: VRM): void {
  mountModelOnAvatar(group, vrm.scene, VRM_BODY_HEIGHT_RATIO, () => {
    const head = vrm.humanoid?.getNormalizedBoneNode("head");
    if (!head) return undefined;
    const headPos = head.getWorldPosition(new THREE.Vector3());
    group.worldToLocal(headPos);
    return headPos.y;
  });
}

/**
 * Upgrade a procedural TV-head avatar group to a rigged VRM robot. Resolves null (procedural
 * avatar untouched) when: the classic escape hatch is set (deterministic picks only — an explicit
 * `storeId` from the avatar picker overrides it), no API base is configured, or anything about
 * the load fails. idle+walk clips are required; wave/jump are best-effort.
 */
export async function attachVrmAvatar(
  group: THREE.Group,
  visitorId: string,
  rendererIsWebGPU: boolean,
  storeId?: string,
  stillWanted?: () => boolean,
): Promise<AvatarRig | null> {
  if (!storeId && classicAvatarRequested()) return null;
  if (!runtimeConfig.worldApiBase) return null;
  try {
    const [vrm, idle, walk, jump, wave] = await Promise.all([
      loadVrm(assetDownloadUrl(storeId ?? pickAvatarId(visitorId)), rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.idle, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.walk, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.jump, rendererIsWebGPU),
      loadOptionalClip(CLIP_IDS.wave, rendererIsWebGPU),
    ]);
    if (!idle || !walk) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error("idle/walk animation clips unavailable");
    }
    // A newer selection (or a prune) superseded this load while it was in flight — never mount a
    // stale model over the current one (mounting also repositions the floating TV).
    if (stillWanted && !stillWanted()) {
      VRMUtils.deepDispose(vrm.scene);
      return null;
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
