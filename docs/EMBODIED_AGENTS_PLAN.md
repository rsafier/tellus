# Plan — replace the in-browser AI with per-user embodied agents

## Goal
Retire the client-side autonomous AI (the browser-run `johnny/mira/sol/atlas` loop + the "Create
Character" UI). Instead, **each end-user gets their own in-cluster Tellus agent** (a Hyades
`ITellusAgentGrain`) bound to their identity, which:
- plays in the world via the grain's `TellusWorldPlugin` (REST grain calls — no browser),
- has a personality the user can edit,
- is **enabled while the user is in the game** and **sleeps when they leave**.

The browser becomes a *viewer* of the agent (renders its avatar from presence, sees its actions as world
patches) plus a small "Your agent" control panel.

## Identity
Reuse the soft user identity from the private-worlds work (`tellusUserId()` → `?userId=`). The user's agent
is keyed `{worldId}/user-{slug(userId)}`; owner = that userId. Same soft model (no login yet) — anyone could
spoof a userId, acceptable "for now," flagged for hardening with real auth.

## Hyades side (most machinery already exists — Phase C `ITellusAgentGrain`)
`ITellusAgentGrain` already has `ConfigureAsync / EnableAsync / DisableAsync / SetPausedAsync / TickAsync /
GetStatusAsync / ObserveAsync / UpdateSelfAsync`, plus the guardrail spine (heartbeat reminder, daily budget,
idle backoff). Today it's reachable only via **admin** endpoints. New work:

1. **User-scoped, non-admin endpoints** (a user manages only their *own* agent; agentId derived server-side
   from the caller's userId, owner-gated like private worlds):
   - `POST   /api/tellus/worlds/{worldId}/agent`         — configure my agent (persona/goal, model, interval, budget)
   - `POST   /api/tellus/worlds/{worldId}/agent/enable`  — start it
   - `POST   /api/tellus/worlds/{worldId}/agent/disable` — stop it
   - `GET    /api/tellus/worlds/{worldId}/agent/status`  — my agent's status
2. **Lifecycle:** enable on join (or an explicit "Start"); **sleep on leave** — when the user's presence is
   pruned (WS close / heartbeat lapse, 90 s TTL), disable/pause their agent so it stops ticking and
   idle-deactivates. The world grain already tracks presence; hook the prune to disable the matching agent.
3. **Cost guardrail:** anonymous users run LLM turns → tokens. Bind to a default tenant + a per-user daily
   token budget (reuse `EmbodiedTickBase`/`TenantGrain`). Pick a sane default cap.

## Client side
- **Add** a "Your agent" panel: enable/disable, edit personality (persona/goal), show status. (This is where
  the deferred personality-UI cleanup lands — the persona editor becomes *your agent's* persona.)
- **Render** the in-cluster agent like any remote visitor: its avatar comes from presence (`agent:{userId}`),
  its actions arrive as world patches (generated/terrain) over `/live`. The client no longer *runs* it.
- **Remove** (staged, after the new path is verified): the autonomous browser-agent loop, the agent seeds
  auto-running, the `/api/chat` + `/api/world-feedback`-driven autonomy, the Create-Character form, and the
  multi-agent selection UI.

## Sequencing
1. Hyades: user-scoped agent endpoints + enable-on-join / sleep-on-leave + per-user budget. Roll hyades-tellus.
2. Client: add the "Your agent" panel; render the in-cluster agent (avatar from presence, actions from patches).
3. Verify the in-cluster play loop, **then** remove the old browser-AI subsystem (separate change — it's large).
4. Personality-UI cleanup is absorbed by step 2.

## Decisions needed before building
- **Enable model:** auto-enable the user's agent on join, or an explicit "Start my agent" button?
  (auto = livelier but spends tokens unprompted; explicit = opt-in.)
- **Named NPCs:** keep `johnny/mira/sol` as **public** world agents (admin-run, always-on), or drop multi-agent
  entirely and have only per-user agents?
- **Budget:** default daily token budget per anonymous user.
- **Removal staging:** confirm we add+verify the new path before ripping out the browser-AI subsystem.
