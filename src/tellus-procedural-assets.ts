import * as THREE from "three";
import { buildProceduralObject, proceduralArchetype } from "./tellus-veg-archetypes";

// ── procedural:// placeable assets ────────────────────────────────────────────────────────────────
// A GeneratedThing whose modelUrl is `procedural://<archetype>?seed=N` renders a locally built
// procedural mesh instead of fetching a GLB — instant, free, fully deterministic, and it flows
// through the EXISTING world protocol untouched (the server treats modelUrl as an opaque string), so
// placement/sync/clone/throw/delete all just work on every client.

export const PROCEDURAL_URL_PREFIX = "procedural://";

export const isProceduralModelUrl = (url: string | undefined | null): url is string =>
  typeof url === "string" && url.startsWith(PROCEDURAL_URL_PREFIX);

export const makeProceduralModelUrl = (archetypeId: string, seed: number): string =>
  `${PROCEDURAL_URL_PREFIX}${archetypeId}?seed=${seed >>> 0}`;

export const parseProceduralModelUrl = (
  url: string,
): { archetypeId: string; seed: number } | null => {
  if (!isProceduralModelUrl(url)) return null;
  const rest = url.slice(PROCEDURAL_URL_PREFIX.length);
  const q = rest.indexOf("?");
  const archetypeId = (q >= 0 ? rest.slice(0, q) : rest).toLowerCase();
  if (!proceduralArchetype(archetypeId)) return null;
  let seed = 1;
  if (q >= 0) {
    const m = /(?:^|[?&])seed=(\d+)/.exec(rest.slice(q));
    if (m) seed = Number(m[1]) >>> 0;
  }
  return { archetypeId, seed };
};

// Small build cache — repeated placements of the same url (clones, remote patches) share nothing
// mutable, so hand out a fresh clone of a cached prototype each time.
const prototypeCache = new Map<string, THREE.Group>();

export const buildProceduralModel = (url: string): THREE.Group | null => {
  const parsed = parseProceduralModelUrl(url);
  if (!parsed) return null;
  let proto = prototypeCache.get(url);
  if (!proto) {
    const built = buildProceduralObject(parsed.archetypeId, parsed.seed);
    if (!built) return null;
    proto = built;
    prototypeCache.set(url, proto);
    if (prototypeCache.size > 200) {
      const first = prototypeCache.keys().next().value;
      if (first) prototypeCache.delete(first);
    }
  }
  // Clone shares geometry/material (cheap); transforms are per-instance.
  return proto.clone(true);
};
