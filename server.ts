import chatHandler from "./api/chat";
import generate3DHandler from "./api/generate-3d";
import generatedAssetsHandler from "./api/generated-assets";
import gradioFileHandler from "./api/gradio-file";
import tellusStateHandler from "./api/tellus-state";
import worldFeedbackHandler from "./api/world-feedback";

const distRoot = new URL("./dist/", import.meta.url);

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

function extension(pathname: string): string {
  const match = /\.[a-z0-9]+$/i.exec(pathname);
  return match?.[0].toLowerCase() ?? "";
}

function safeDistUrl(pathname: string): URL {
  const decoded = decodeURIComponent(pathname);
  const cleanPath = decoded
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
  return new URL(cleanPath || "index.html", distRoot);
}

async function serveStatic(pathname: string): Promise<Response> {
  const fileUrl = safeDistUrl(pathname);
  let file = Bun.file(fileUrl);
  let servedPathname = pathname === "/" ? "/index.html" : pathname;
  if (!(await file.exists())) {
    file = Bun.file(new URL("index.html", distRoot));
    servedPathname = "/index.html";
  }
  return new Response(file, {
    headers: {
      "Cache-Control": servedPathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "Content-Type":
        contentTypes[extension(servedPathname)] ?? "application/octet-stream",
    },
  });
}

const port = Number(process.env.PORT ?? 3000);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (url.pathname === "/health") {
      return withCors(Response.json({ ok: true, service: "tellus" }));
    }
    if (url.pathname.startsWith("/api/chat")) {
      return withCors(await chatHandler(request));
    }
    if (url.pathname.startsWith("/api/generate-3d")) {
      return withCors(await generate3DHandler(request));
    }
    if (url.pathname.startsWith("/api/gradio-file")) {
      return withCors(await gradioFileHandler(request));
    }
    if (url.pathname.startsWith("/api/tellus-state")) {
      return withCors(await tellusStateHandler(request));
    }
    if (url.pathname.startsWith("/api/world-feedback")) {
      return withCors(await worldFeedbackHandler(request));
    }
    if (url.pathname.startsWith("/generated-assets/")) {
      return withCors(await generatedAssetsHandler(request));
    }
    if (url.pathname.startsWith("/api/")) {
      return withCors(
        Response.json(
          { error: "Tellus API route not found", path: url.pathname },
          { status: 404 },
        ),
      );
    }
    return withCors(await serveStatic(url.pathname));
  },
});

console.log(`Tellus listening on :${port}`);
