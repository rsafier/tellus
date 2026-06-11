import { runtimeConfig } from "./tellus-runtime-config";
import { browserUuid } from "./tellus-utils";
import { sessionAccountId } from "./tellus-auth";

let pageVisitorId: string | undefined;
let stableUserId: string | undefined;

export function tellusWorldHttpUrl(route: "state" | "action"): string {
  // Carry the stable (anonymous) user id so private worlds bind to / gate on the visitor. The WS URL
  // inherits it because tellusWorldWebSocketUrl is derived from the "state" URL.
  return `${runtimeConfig.worldApiBase}/api/world/${encodeURIComponent(runtimeConfig.worldId)}/${route}?userId=${encodeURIComponent(tellusUserId())}`;
}

export function tellusAgentUrl(action: "start" | "stop" | "persona" | "status" | "transcript" | "say" | "view" | "memories"): string {
  // Per-user embodied-agent control endpoints; carry the stable user id (missing => 401 from the backend).
  return `${runtimeConfig.worldApiBase}/api/world/${encodeURIComponent(runtimeConfig.worldId)}/agent/${action}?userId=${encodeURIComponent(tellusUserId())}`;
}

export function tellusAssetLibraryUrl(path: string): string {
  return `${runtimeConfig.worldApiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export function tellusWorldWebSocketUrl(visitorId: string): string {
  const httpUrl = new URL(tellusWorldHttpUrl("state"), window.location.href);
  httpUrl.pathname = httpUrl.pathname.replace(/\/state\/?$/, "/live");
  httpUrl.searchParams.set("visitorId", visitorId);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

export function tellusVisitorId(): string {
  if (!pageVisitorId) {
    // Honor a host-pinned identity (window.__hyadesIdentity or a ?visitorId= query param) before falling
    // back to a fresh random id — lets an embodied external agent join as a stable, distinct visitor.
    const injected =
      window.__hyadesIdentity?.visitorId ??
      new URLSearchParams(window.location.search).get("visitorId") ??
      undefined;
    pageVisitorId = injected && injected.trim() ? injected.trim() : browserUuid();
  }
  return pageVisitorId;
}

export function tellusUserId(): string {
  // Logged in => the account IS the identity (worlds/agents bind to it). The anonymous uuid below
  // stays untouched in localStorage ("tellus.userId") so it can be CLAIMED onto the account later.
  const accountId = sessionAccountId();
  if (accountId) return accountId;
  if (stableUserId) return stableUserId;
  const storageKey = "tellus.userId";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    stableUserId = existing;
    return stableUserId;
  }
  stableUserId = browserUuid();
  window.localStorage.setItem(storageKey, stableUserId);
  return stableUserId;
}

export function speakTellusText(text: string): void {
  if (!("speechSynthesis" in window)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.rate = 0.96;
  utterance.pitch = 1.04;
  window.speechSynthesis.speak(utterance);
}

export function toAssetId(prompt: string, prefix: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `tellus-${prefix}-${slug || "creation"}-${Date.now().toString(36)}`;
}

export function absoluteAssetForgeUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${runtimeConfig.assetForgeApiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export function tellusApiUrl(path: string): string {
  return `${runtimeConfig.apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export function absoluteTellusApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return tellusApiUrl(path);
}
