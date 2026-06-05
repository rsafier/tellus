import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedAssetRoot } from "./generated-assets";

interface Generate3DRequest {
  id?: string;
  prompt?: string;
  kind?: string;
  imageUrl?: string;
  removeBackground?: boolean;
  sampleSteps?: number;
  seed?: number;
}

interface Generate3DResponse {
  jobId: string;
  modelUrl: string;
  provider: "instantmesh-gradio";
  rawModelUrl: string;
  storedModelUrl: string;
  storedModelPath: string;
  manifestUrl: string;
}

interface LegacyPredictResponse {
  data?: unknown[];
  error?: string;
}

type FileLikeResult = {
  url?: string;
  path?: string;
  name?: string;
  data?: string;
  orig_name?: string;
};

interface GeneratedAssetManifestEntry {
  id: string;
  prompt: string;
  kind: string;
  provider: "instantmesh-gradio";
  rawModelUrl: string;
  modelUrl: string;
  storedModelPath: string;
  createdAt: string;
  sampleSteps: number;
  seed: number;
}

function conceptImageDataUrl(prompt: string, kind: string): string {
  const width = 256;
  const height = 256;
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const fileSize = 54 + pixelBytes;
  const buffer = Buffer.alloc(fileSize);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(fileSize, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);

  const hue = Array.from(`${kind}:${prompt}`).reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  const base = [
    52 + (hue % 90),
    120 + (hue % 80),
    58 + (hue % 70),
  ] as const;

  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = 54 + (height - 1 - y) * rowStride + x * 3;
    buffer[offset] = b;
    buffer[offset + 1] = g;
    buffer[offset + 2] = r;
  };
  const fillRect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number],
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) setPixel(x, y, color[0], color[1], color[2]);
    }
  };
  const fillEllipse = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    color: readonly [number, number, number],
  ) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) setPixel(x, y, color[0], color[1], color[2]);
      }
    }
  };
  const fillTriangle = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    color: readonly [number, number, number],
  ) => {
    const minX = Math.floor(Math.min(ax, bx, cx));
    const maxX = Math.ceil(Math.max(ax, bx, cx));
    const minY = Math.floor(Math.min(ay, by, cy));
    const maxY = Math.ceil(Math.max(ay, by, cy));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
        const w1 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) / area;
        const w2 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) / area;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
          setPixel(x, y, color[0], color[1], color[2]);
        }
      }
    }
  };

  fillRect(0, 0, width, height, [238, 242, 232]);
  fillEllipse(128, 204, 76, 18, [190, 202, 174]);

  if (kind === "tree" || prompt.toLowerCase().includes("tree")) {
    fillRect(116, 120, 140, 204, [112, 75, 41]);
    fillEllipse(128, 98, 70, 58, [base[0], base[1], base[2]]);
    fillEllipse(92, 124, 44, 42, [58, 135, 68]);
    fillEllipse(164, 122, 48, 44, [76, 154, 72]);
  } else if (kind === "flower") {
    fillRect(124, 112, 132, 204, [54, 132, 74]);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      fillEllipse(128 + Math.cos(angle) * 28, 94 + Math.sin(angle) * 24, 22, 18, [
        222,
        108 + (hue % 90),
        168,
      ]);
    }
    fillEllipse(128, 96, 18, 18, [242, 199, 69]);
  } else if (kind === "animal") {
    fillEllipse(126, 142, 66, 40, [base[0], base[1], base[2]]);
    fillEllipse(184, 126, 30, 28, [base[0], base[1], base[2]]);
    fillTriangle(170, 106, 182, 78, 194, 108, [base[0], base[1], base[2]]);
    fillRect(84, 174, 98, 210, [70, 70, 62]);
    fillRect(150, 174, 164, 210, [70, 70, 62]);
  } else if (kind === "path") {
    fillTriangle(76, 212, 180, 212, 146, 62, [154, 124, 72]);
    fillTriangle(110, 212, 210, 212, 154, 86, [176, 142, 82]);
  } else if (kind === "shrine") {
    fillRect(76, 176, 180, 204, [112, 86, 66]);
    fillRect(96, 104, 160, 176, [172, 157, 134]);
    fillTriangle(74, 104, 128, 58, 182, 104, [86, 72, 92]);
  } else if (kind === "balloon" || prompt.toLowerCase().includes("balloon")) {
    fillEllipse(128, 88, 58, 66, [230, 132, 78]);
    fillEllipse(104, 90, 20, 56, [248, 188, 104]);
    fillEllipse(152, 90, 20, 56, [248, 188, 104]);
    fillRect(122, 146, 134, 174, [80, 58, 42]);
    fillRect(96, 178, 160, 210, [132, 82, 44]);
    fillRect(102, 184, 158, 190, [94, 61, 38]);
    fillTriangle(102, 144, 96, 178, 108, 178, [80, 58, 42]);
    fillTriangle(154, 144, 148, 178, 160, 178, [80, 58, 42]);
  } else {
    fillEllipse(128, 144, 72, 54, [base[0], base[1], base[2]]);
    fillEllipse(104, 116, 28, 24, [base[0] + 20, base[1] + 20, base[2] + 20]);
    fillEllipse(158, 118, 36, 30, [base[0] + 10, base[1] + 18, base[2] + 12]);
  }

  return `data:image/bmp;base64,${buffer.toString("base64")}`;
}

function collectCandidates(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCandidates(item));
  }
  if (!value || typeof value !== "object") return [];
  const file = value as FileLikeResult;
  return [
    file.url,
    file.path,
    file.name,
    file.data,
    file.orig_name,
    ...Object.values(value).flatMap((item) => collectCandidates(item)),
  ].filter((item): item is string => typeof item === "string");
}

function resolveGradioFileUrl(baseUrl: string, candidate: string): string {
  if (/^data:/i.test(candidate)) return candidate;
  if (/^https?:/i.test(candidate)) return candidate;
  if (candidate.startsWith("/")) {
    if (candidate.startsWith("/tmp/") || candidate.startsWith("/var/")) {
      return new URL(`/file=${candidate}`, `${baseUrl}/`).toString();
    }
    return new URL(candidate, `${baseUrl}/`).toString();
  }
  return new URL(`/file=${candidate}`, `${baseUrl}/`).toString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(cleanUpstreamError(response.status, body));
  }
  return response.arrayBuffer();
}

async function appendManifest(entry: GeneratedAssetManifestEntry): Promise<void> {
  const manifestPath = join(generatedAssetRoot(), "manifest.json");
  let existing: GeneratedAssetManifestEntry[] = [];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      existing = parsed.filter(
        (item): item is GeneratedAssetManifestEntry =>
          typeof item === "object" && item !== null,
      );
    }
  } catch {
    existing = [];
  }
  existing.push(entry);
  await writeFile(
    manifestPath,
    `${JSON.stringify(existing, null, 2)}\n`,
    "utf8",
  );
}

async function persistGeneratedModel(params: {
  id: string;
  prompt: string;
  kind: string;
  rawModelUrl: string;
  sampleSteps: number;
  seed: number;
}): Promise<GeneratedAssetManifestEntry> {
  const root = generatedAssetRoot();
  await mkdir(root, { recursive: true });

  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const filename = `${timestamp}-${slugify(params.kind)}-${slugify(
    params.prompt,
  ) || params.id}.glb`;
  const finalPath = join(root, filename);
  const tempPath = `${finalPath}.tmp`;
  const modelBytes = await fetchArrayBuffer(params.rawModelUrl);
  await writeFile(tempPath, Buffer.from(modelBytes));
  await rename(tempPath, finalPath);

  const entry: GeneratedAssetManifestEntry = {
    id: params.id,
    prompt: params.prompt,
    kind: params.kind,
    provider: "instantmesh-gradio",
    rawModelUrl: params.rawModelUrl,
    modelUrl: `/generated-assets/${encodeURIComponent(filename)}`,
    storedModelPath: finalPath,
    createdAt,
    sampleSteps: params.sampleSteps,
    seed: params.seed,
  };
  await appendManifest(entry);
  return entry;
}

function cleanUpstreamError(status: number, body: string): string {
  if (status === 524) {
    return "InstantMesh timed out upstream before returning a model";
  }
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return `InstantMesh request failed with HTTP ${status}`;
  return `InstantMesh request failed with HTTP ${status}: ${text.slice(0, 240)}`;
}

async function readRequestJson(request: Request): Promise<Generate3DRequest> {
  const parsed = (await request.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Generate3DRequest;
}

export async function generate3DHandler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = await readRequestJson(request);
  const baseUrl = process.env.INSTANTMESH_GRADIO_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return Response.json(
      { error: "INSTANTMESH_GRADIO_BASE_URL is not configured" },
      { status: 503 },
    );
  }

  const prompt = payload.prompt?.trim() || "tiny Tellus world object";
  const kind = payload.kind?.trim() || "object";
  const imageUrl = payload.imageUrl?.trim() || conceptImageDataUrl(prompt, kind);
  const sampleSteps = payload.sampleSteps ?? Number(process.env.INSTANTMESH_SAMPLE_STEPS || 30);
  const seed = payload.seed ?? Date.now() % 1_000_000;
  const response = await fetch(`${baseUrl}/run/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [imageUrl, payload.removeBackground ?? false, sampleSteps, seed],
      fn_index: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return Response.json(
      { error: cleanUpstreamError(response.status, body) },
      { status: 502 },
    );
  }

  const body = (await response.json()) as LegacyPredictResponse;
  if (body.error) {
    return Response.json({ error: body.error }, { status: 502 });
  }

  const candidate = collectCandidates(body.data?.[4]).find((value) =>
    /\.(glb|gltf)(\?|$)/i.test(value),
  );
  if (!candidate) {
    return Response.json(
      { error: "InstantMesh completed without a GLB output", data: body.data },
      { status: 502 },
    );
  }

  const rawModelUrl = resolveGradioFileUrl(baseUrl, candidate);
  let stored: GeneratedAssetManifestEntry;
  try {
    stored = await persistGeneratedModel({
      id: payload.id || `instantmesh-${Date.now()}`,
      prompt,
      kind,
      rawModelUrl,
      sampleSteps,
      seed,
    });
  } catch (error) {
    return Response.json(
      {
        error: `InstantMesh returned a GLB, but Tellus could not persist it: ${
          error instanceof Error ? error.message : "unknown storage error"
        }`,
        rawModelUrl,
      },
      { status: 502 },
    );
  }
  const result: Generate3DResponse = {
    jobId: stored.id,
    modelUrl: stored.modelUrl,
    provider: "instantmesh-gradio",
    rawModelUrl,
    storedModelUrl: stored.modelUrl,
    storedModelPath: stored.storedModelPath,
    manifestUrl: "/generated-assets/manifest.json",
  };
  return Response.json(result);
}

export default generate3DHandler;
