# Release Notes

Tellus — the 3D web "world" game client (React + three.js), backed by the in-cluster Hyades world.
Newest first. Versions are the deployed image tag (`192.168.1.187:30500/tellus:<tag>`); a `v<tag>` git tag
on the gnostr-cloud `master` triggers the CI build + rollout.

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
