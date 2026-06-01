import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import chatHandler from "./api/chat";
import generate3DHandler from "./api/generate-3d";
import gradioFileHandler from "./api/gradio-file";

function normalizeHyadesBaseUrl(baseUrl: string) {
  return /\/v\d+\/?$/i.test(baseUrl)
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, "")}/v1`;
}

async function bodyFromRequest(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function sendWebResponse(
  response: import("node:http").ServerResponse,
  webResponse: Response,
) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    response.write(Buffer.from(next.value));
  }
  response.end();
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  for (const key of [
    "ZAI_BASE_URL",
    "ZAI_API_KEY",
    "ZAI_MODEL",
    "HYADES_BASE_URL",
    "HYADES_API_KEY",
  ]) {
    if (env[key]) process.env[key] = env[key];
  }
  const hyadesBaseUrl = normalizeHyadesBaseUrl(
    env.HYADES_BASE_URL ?? "http://192.168.1.187/v1",
  );
  const hyadesApiKey = env.HYADES_API_KEY;

  return {
    server: {
      host: true,
      port: 3344,
      strictPort: true,
      proxy: !env.ZAI_API_KEY && hyadesApiKey
        ? {
            "/api/chat": {
              target: hyadesBaseUrl,
              changeOrigin: true,
              rewrite: () => "/chat/completions",
              headers: {
                Authorization: `Bearer ${hyadesApiKey}`,
              },
            },
            "/api/tts": {
              target: hyadesBaseUrl,
              changeOrigin: true,
              rewrite: () => "/tts",
              headers: {
                Authorization: `Bearer ${hyadesApiKey}`,
              },
            },
          }
        : undefined,
    },
    plugins: [
      react(),
      {
        name: "tellus-api-dev",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/api/chat") || !env.ZAI_API_KEY) {
              next();
              return;
            }
            const body = await bodyFromRequest(request);
            const webRequest = new Request(`http://localhost${request.url}`, {
              method: request.method ?? "GET",
              headers: request.headers as HeadersInit,
              body:
                request.method === "GET" || request.method === "HEAD"
                  ? undefined
                  : body,
            });
            await sendWebResponse(response, await chatHandler(webRequest));
          });
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/api/generate-3d")) {
              next();
              return;
            }
            const body = await bodyFromRequest(request);
            const webRequest = new Request(
              `http://localhost${request.url}`,
              {
                method: request.method ?? "GET",
                headers: request.headers as HeadersInit,
                body:
                  request.method === "GET" || request.method === "HEAD"
                    ? undefined
                    : body,
              },
            );
            await sendWebResponse(response, await generate3DHandler(webRequest));
          });
          server.middlewares.use(async (request, response, next) => {
            if (!request.url?.startsWith("/api/gradio-file")) {
              next();
              return;
            }
            const webRequest = new Request(`http://localhost${request.url}`, {
              method: request.method,
              headers: request.headers as HeadersInit,
            });
            await sendWebResponse(response, await gradioFileHandler(webRequest));
          });
        },
      },
    ],
  };
});
