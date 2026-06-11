# Release Notes

Tellus — the 3D web "world" game client (React + three.js), backed by the in-cluster Hyades world.
Newest first. Versions are the deployed image tag (`192.168.1.187:30500/tellus:<tag>`); a `v<tag>` git tag
on the gnostr-cloud `master` triggers the CI build + rollout.

## 0.7.6 — 2026-06-10
- **Object lighting: no more "dirty" look.** Placed GLB assets are PBR materials, and the scene had no
  environment map — metallic/rough surfaces had nothing to reflect, so objects rendered muddy except
  when the sun hit them dead-on (sunrise/noon). The scene now carries a procedural sky-horizon-ground
  environment map (works on WebGPU and WebGL) whose intensity follows the day/night cycle — objects
  pick up believable ambient reflections all day and gently dim at night.
- **Drag objects to move them.** Select an object, then **press and drag it** — it follows your
  pointer across the terrain (grounded; vehicles keep their water rules), streaming its position to
  other players as it moves and settling with an authoritative publish on release. Dragging anywhere
  else still orbits the camera, so: click to select, grab to move. Works with touch. The panel nudge
  controls remain for fine adjustment.

## 0.7.5 — 2026-06-10
- **"Clean up dead references" button** (Assets → World tab). Scans every placed object for models
  that are definitively gone — failed/stripped placements from the old loader bug, store models that
  have since been deleted (404/410, probed through the proxy with bounded concurrency), and broken
  `procedural://` links — then shows a confirm with a preview list before deleting them via the normal
  tombstoned delete path. Conservative by design: network errors and 5xx count as ALIVE, so a store
  outage can never mass-delete a world. First run on the main world found 21 dead objects.

## 0.7.4 — 2026-06-10
- **Fix: TEXTURED game-optimized models (Mars etc.) failed to load.** The store's game-optimized GLBs
  compress textures to KTX2/Basis (`KHR_texture_basisu`) — untextured models (ores, flowers) only need
  meshopt and worked, but anything with textures failed to parse because no KTX2 loader was wired.
  Tellus now ships the Basis transcoder (self-hosted under `/basis/`), attaches a `KTX2Loader` to the
  GLTF pipeline, and detects the GPU's transcode targets at renderer init (WebGPU + WebGL). Failed GLB
  loads are also no longer cached for the whole session, so transient errors retry.

## 0.7.3 — 2026-06-10
- **Real 3D Asset Manager integration: search, thumbnails, the whole store.** The Assets panel's
  Search tab previously showed a fixed 24-model slice — most of the store (275+ models, including all
  the game-optimized ores) was unreachable. It's now a live, server-side browse of the store through
  the existing Hyades proxy: a **search box** (debounced, full-text), **preview thumbnails** on every
  card that has one, a **game-optimized badge**, tags, sort chips (**Newest / Popular / A–Z**), a
  result counter, and **Load more** pagination through the entire catalog. Placement still uses the
  game-optimized GLB (~80% smaller) with the original-file fallback.

## 0.7.2 — 2026-06-10
- **Agent "Thinking…" feedback.** The Your Agent status badge now shows a blue **Thinking…** state
  while the agent is mid-turn (LLM call in flight), and the chat thread shows a "💭 thinking…" line —
  so you can tell working from idle at a glance.
- **The POV viewport survives closing the panel.** The agent keeps running when you close the tab, so
  its viewport now stays on screen until you toggle it off; the chat thread also persists across
  open/close, and status keeps polling while the viewport is up.
- **Bigger default range + two more tiers.** GIGA (84u) is now the **default** on WebGPU, with TERA
  (108u) and COSMIC (136u, ~440 chunks) above it — the 30fps-floor controller climbs into them on
  sustained headroom.
- **World feel: bigger, smoother, no see-through.** Trees ~35% taller across all species, taller
  grass, bigger bushes/reeds/crystals/boulders; rocks and boulders are now smooth detail-1 spheres
  with gentle deformation (no more d20s); stones sit much deeper in the ground so slopes never open a
  see-through gap under a rock's rim.

## 0.7.1 — 2026-06-10
- **Fix: placed procedural nature rendered as a blob/swirl, then vanished.** Inbound world patches run
  every modelUrl through a legacy absolutizer (for old relative GLB paths), which mangled
  `procedural://…` into `/procedural://…` — the server's own echo of your placement then broke the
  local build path, fell into a network fetch (the `/procedural://… 500`s in the console), flagged the
  thing "failed", and published the stripped state back. Procedural URLs are now passed through
  verbatim, the loader heals any already-mangled ones, and previously-wiped placements just need
  re-placing (one tap).
- **Vegetation fills MUCH farther — 30fps floor.** Per the operator: as long as it holds 30fps, fill.
  Two new quality tiers (ULTRA 64u, **GIGA 84u** grass radius, up to ~175 active chunks), the
  controller now sheds below ~32fps and climbs on sustained 42+fps headroom, and the chunk-rebuild
  budget rises to 3/frame when fast.

## 0.7.0 — 2026-06-10
- **Scaled worlds.** Name a world `large-…` (or `big-`/`xl-`) and it's **3× the radius — 9× the
  area**; `mega-`/`giant-` is 5×/25×. The whole island scales: mountain, ridge, pond, archipelago
  ring, fog, camera, sky, minimap — and you walk ~2–3× faster so it still feels traversable. Zero
  protocol change (the terrain grid stretches; sync payloads are identical) and the Hyades terrain
  port applies the same math, so server grounding + embodied agents stay correct. The public
  **large-world** is live — pick it from the world switcher.
- **Way higher procedural limits + 10 new species.** The vegetation system now grows palms (beach),
  tall pines & birches, dead trees, bushes, ferns, **reeds along the waterline and pond shore**,
  mushrooms, rare crystal clusters on rock/snow, and walk-blocking boulders — all biome-aware. Trees
  and rocks moved to 72u **sectors** (frustum-culled, rebuilt one per frame) so huge worlds don't pay
  for off-screen forests, and a new **ULTRA quality tier** (denser, 54u grass radius) engages on
  WebGPU when the FPS has sustained headroom.
- **Place procedural nature like assets.** A new **Nature** tab in the Assets panel places any
  archetype instantly — `procedural://` model URLs ride the normal object pipeline, so they sync to
  every client, and you can move, scale, clone, **throw**, and delete them like anything else. Every
  placement rolls a fresh seed/tint variation. Zero generation cost, zero backend involvement.

## 0.6.0 — 2026-06-10
- **Procedural vegetation (Crysis-style ground cover).** The island now grows wind-swayed grass and
  flowers streamed in chunks around you, plus ~100+ procedural low-poly trees and rock scatter — all
  terrain-aware (paint kind, height, slope, water/pond exclusion) and fully deterministic, so every
  client grows the identical world with zero new protocol. Sculpting or painting the terrain re-grows
  the affected vegetation lazily. On WebGPU the grass is a TSL node material with per-blade flutter, a
  traveling gust front, **bend-away-as-you-walk-through**, and a shrink-into-the-ground distance fade;
  the WebGL fallback renders the same geometry statically. Each chunk is one merged draw call stamped
  into pre-allocated buffers (zero steady-state allocation), and an **adaptive quality controller**
  drops density/radius tiers when FPS dips and climbs back when there's headroom.
- **Physics.** (1) **Throw things**: select any placed object and press **G** (or the new Throw button)
  to hurl it where you're looking — it arcs, tumbles, bounces off terrain slopes (real surface
  normals), or splashes into water and bobs up to float; the rest pose publishes through the normal
  upsert path so every client converges, and the flight streams at ~7 Hz for spectators. Balloons are
  floaty. (2) **Jump** with Space (and fall off ledges instead of snapping down). (3) **Solid
  obstacles**: trees and large placed objects now push you out instead of being walk-through holograms.
- Debug overlay (triple-click) gains a vegetation/physics line (tier, chunks, tris, trees, bodies).

## 0.5.2 — 2026-06-10
- **Chat with your agent.** The "Your Agent" panel's read-only Dialog feed is now a two-way **Chat**: a text
  box + Send (Enter to send) posts to the new Hyades `POST /agent/say`, your line appears immediately, and the
  agent's reply arrives in the same thread via the existing transcript poll (your lines and the agent's dialog
  interleave in send/reply order; tool actions stay dimmed). Requires the agent to be started (the box is
  disabled and prompts you to start it otherwise — chatting never silently spends tokens). The thread is
  per-session (clears on panel close); the agent itself remembers the conversation in its durable thread.

## 0.5.1 — 2026-06-10
- **Fix: the agent POV viewport showed the player's sky, not the agent's.** The skybox dome, moon, and moon
  cloud-veil are repositioned every frame to follow the *player* camera, so the picture-in-picture rendered
  them locked to the player instead of the agent — the sky/moon in the PiP tracked your movement, not the
  agent's. The PiP render now shifts those camera-following celestials onto the POV camera for its draw and
  restores them immediately after (guarded so a dropped frame can't desync the moon).

## 0.5.0 — 2026-06-10
- **Agent feedback in-game: dialog feed + POV viewport.** The "Your Agent" panel now shows what your
  server-side agent is doing. A **Dialog feed** (polled on the same ~3s cadence as status) streams the
  agent's recent assistant lines and tool calls from the new Hyades transcript endpoint
  (`GET /api/world/{id}/agent/transcript`); it auto-scrolls to the newest line only when you're already at
  the bottom, so reading older lines isn't interrupted. A **Show/Hide viewport** toggle renders a 220×140
  picture-in-picture of the scene from the agent avatar's point of view (a second camera at the avatar's
  head, bottom-left, both WebGL and WebGPU). The panel gained a height cap + scroll so it never overflows on
  short viewports.

## 0.4.0 — 2026-06-10
- **P2P audio + mute/unmute.** The WebRTC mesh now captures the mic alongside 480p video (echo-cancel /
  noise-suppress / auto-gain), sends it on an audio transceiver, and accumulates a peer's audio+video into
  one remote stream. Two new P2P-panel controls: **🔊 Listen** (hear other players — off by default since
  browsers block autoplay audio without a gesture) and **🎤 Mic** (mute/unmute your own mic while TX is on).
- **Fix: the P2P and "Your Agent" panels no longer overlap** — they now sit side-by-side (P2P just left of
  center, agent just right) instead of both centered on top of each other.

## 0.3.0 — 2026-06-10
- **Removed the in-browser AI (per-user embodied agents, Roll 3).** The legacy browser-run NPCs
  (johnny/mira/sol) and their whole subsystem are gone — the autonomous decision loop, agent meshes, the
  agent-vision world-feedback loop, the AI tool panel + World Chat panel, and the server routes `api/chat.ts`
  + `api/world-feedback.ts`. Players now run their own server-side agent via the "Your Agent" panel (0.2.0);
  the browser no longer runs AI or spends tokens. Net −1,846 lines (`tellus-agent-llm.ts` deleted); the
  bundle shrank ~25 KB. All non-AI features (presence/avatars, `/live`, terrain, generation, asset library,
  P2P video, debug overlay, world switching, the external `window.tellusAgent` driver hook) are untouched.

## 0.2.0 — 2026-06-10
- **"Your Agent" panel (per-user embodied agents, Roll 2).** A new toolbelt panel lets each player run their
  own in-cluster Hyades agent instead of the shared browser NPCs: **Start my agent** / **Stop** (opt-in, no
  auto-spend), a status badge (Stopped / Running / **Sleeping** — it sleeps when you leave, unless you're
  premium), a **Premium** chip, a persona editor (saved to the agent), and a tokens-used / daily-budget
  line. The agent renders through the existing remote-presence path (robot/TV-head) and acts in the world
  over `/live` — the browser no longer runs it. New `tellusAgentUrl()` helper + the `/api/world/{id}/agent/*`
  endpoints. (The legacy browser NPCs johnny/mira/sol still run this release; their removal is Roll 3.)

## 0.1.x — 2026-06-09/10
- **gnostr-cloud CI/CD (tag-to-publish).** A `v*` git tag on the gnostr-cloud `master` builds the multi-arch
  image and rolls the live k3s deployment automatically (`.gnostr-cloud-ci.yml` + `deploy/build-push.sh`).
- **P2P video (robot / TV-head avatars).** WebRTC full-mesh (`src/webrtc-mesh.ts`): RX-on/TX-off default,
  480p, 16-stream cap, perfect negotiation; signaling rides the world `/live` socket. P2P panel + self-view
  + a triple-click debug overlay.
- **Game-optimized assets.** Library models load `/api/assets/model/{id}/game-optimized` (meshopt, ~80%
  smaller, same quality).
- **Private/public worlds** bound to a soft user identity; **world switching** (list / switch / create).
- **Hyades-backed world + generation.** The world state, 3D generation, LLM, and vision all run in the
  Hyades cluster (`worldApiBase` → `hyades.gnostr.cloud`), replacing the Cloudflare Durable Object + the
  in-browser provider wiring. Integrated asset-library proxy with public fail-over.
- **Refactor.** Split the 9.2k-line `src/main.tsx` into a clean dependency-DAG of modules
  (`tellus-types`/`constants`/`utils`/`runtime-config`/`urls-identity`/`terrain`/`generation-client`/
  `scene-builders`/`agent-llm`, plus `world-builders`/`webrtc-mesh`).
- Performance: GLB no longer re-downloads on move/rescale; flag-gated static-duplicate instancing; a Clone
  button; in-browser AI defaults OFF.
