#!/usr/bin/env bun
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
}

const target = args.get("target") ?? "tellus";
const runs = Number(args.get("runs") ?? 3);
const warmup = Number(args.get("warmup") ?? 1);
const steps = Number(args.get("steps") ?? process.env.INSTANTMESH_SAMPLE_STEPS ?? 30);
const seed = Number(args.get("seed") ?? 4242);
const apiBase = trimSlash(args.get("api-base") ?? process.env.TELLUS_API_BASE ?? "http://127.0.0.1:3000");
const gradioBase = trimSlash(args.get("gradio-base") ?? process.env.INSTANTMESH_GRADIO_BASE_URL ?? "http://127.0.0.1:43839");
const outDir = resolve(args.get("out-dir") ?? "benchmarks");

if (!Number.isFinite(runs) || runs < 1) throw new Error("--runs must be >= 1");
if (!Number.isFinite(warmup) || warmup < 0) throw new Error("--warmup must be >= 0");
if (!["tellus", "gradio"].includes(target)) {
  throw new Error("--target must be tellus or gradio");
}

const prompts = [
  { kind: "tree", prompt: "small windswept bonsai tree with a rounded canopy" },
  { kind: "flower", prompt: "single stylized tulip with broad leaves" },
  { kind: "object", prompt: "tiny mossy stone lantern" },
  { kind: "animal", prompt: "simple toy-like forest fox figurine" },
];

await mkdir(outDir, { recursive: true });
await assertReachable(target === "tellus" ? `${apiBase}/health` : gradioBase);

const measurements = [];
for (let i = 0; i < warmup + runs; i += 1) {
  const item = prompts[i % prompts.length];
  const measured = i >= warmup;
  const label = measured ? `run ${i - warmup + 1}/${runs}` : `warmup ${i + 1}/${warmup}`;
  console.log(`${label}: ${item.prompt}`);

  const started = performance.now();
  const beforeGpu = gpuSnapshot();
  const result =
    target === "tellus"
      ? await callTellus(item, i)
      : await callGradio(item, i);
  const afterGpu = gpuSnapshot();
  const elapsedMs = performance.now() - started;

  if (measured) {
    measurements.push({
      index: measurements.length,
      prompt: item.prompt,
      kind: item.kind,
      elapsedMs: Math.round(elapsedMs),
      sampleSteps: steps,
      seed: seed + i,
      result,
      gpu: { before: beforeGpu, after: afterGpu },
    });
  }
}

const summary = summarize(measurements.map((item) => item.elapsedMs));
const report = {
  createdAt: new Date().toISOString(),
  target,
  apiBase: target === "tellus" ? apiBase : undefined,
  gradioBase,
  runs,
  warmup,
  sampleSteps: steps,
  seed,
  summary,
  measurements,
};

const outPath = resolve(
  outDir,
  `instantmesh-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log("");
console.log(`p50 ${summary.p50Ms} ms | p95 ${summary.p95Ms} ms | mean ${summary.meanMs} ms`);
console.log(`wrote ${outPath}`);

async function callTellus(item, index) {
  const response = await fetch(`${apiBase}/api/generate-3d`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: `bench-${Date.now()}-${index}`,
      provider: "instantmesh-gradio",
      prompt: item.prompt,
      kind: item.kind,
      sampleSteps: steps,
      seed: seed + index,
    }),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) throw new Error(body.error ?? `Tellus returned HTTP ${response.status}`);
  const finalBody = body.status === "completed" || !body.jobId ? body : await pollTellus(body.jobId);
  const storedSizeBytes = await fileSize(finalBody.storedModelPath);
  return {
    jobId: finalBody.jobId,
    modelUrl: finalBody.modelUrl,
    rawModelUrl: finalBody.rawModelUrl,
    storedModelPath: finalBody.storedModelPath,
    storedSizeBytes,
    textImageProvider: finalBody.textImageProvider,
  };
}

async function pollTellus(jobId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const response = await fetch(`${apiBase}/api/generate-3d?jobId=${encodeURIComponent(jobId)}`);
    const body = await response.json();
    if (body.status === "completed") return body;
    if (body.status === "failed" || body.error) {
      throw new Error(body.error ?? `Tellus job ${jobId} failed`);
    }
  }
  throw new Error(`Tellus job ${jobId} timed out`);
}

async function callGradio(item, index) {
  const response = await fetch(`${gradioBase}/run/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        conceptImageDataUrl(item.prompt, item.kind),
        true,
        steps,
        seed + index,
      ],
      fn_index: 1,
    }),
  });
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Gradio returned HTTP ${response.status}`);
  }
  const candidates = collectStrings(body.data?.[4]).filter((value) => /\.(glb|gltf)(\?|$)/i.test(value));
  return {
    outputNames: Array.isArray(body.data) ? body.data.map((value) => describeOutput(value)) : [],
    modelCandidate: candidates[0],
  };
}

async function assertReachable(url) {
  const response = await fetch(url).catch((error) => {
    throw new Error(`Cannot reach ${url}: ${error.message}`);
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(path) {
  if (!path) return undefined;
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    minMs: Math.round(sorted[0]),
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
    meanMs: Math.round(mean),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function gpuSnapshot() {
  const result = spawnSync("nvidia-smi", [
    "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
    "--format=csv,noheader,nounits",
  ], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, memoryUsedMiB, memoryTotalMiB, utilizationGpuPct, temperatureC] =
        line.split(",").map((part) => part.trim());
      return {
        index: Number(index),
        name,
        memoryUsedMiB: Number(memoryUsedMiB),
        memoryTotalMiB: Number(memoryTotalMiB),
        utilizationGpuPct: Number(utilizationGpuPct),
        temperatureC: Number(temperatureC),
      };
    });
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, out));
  }
  return out;
}

function describeOutput(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const maybePath = value.path ?? value.name ?? value.url;
    return maybePath ? basename(String(maybePath)) : Object.keys(value).join(",");
  }
  return typeof value;
}

function conceptImageDataUrl(prompt, kind) {
  const width = 256;
  const height = 256;
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(buffer.byteLength, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);

  const hue = Array.from(`${kind}:${prompt}`).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const base = [52 + (hue % 90), 120 + (hue % 80), 58 + (hue % 70)];
  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = 54 + (height - 1 - y) * rowStride + x * 3;
    buffer[offset] = b;
    buffer[offset + 1] = g;
    buffer[offset + 2] = r;
  };
  const fillRect = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) setPixel(x, y, color[0], color[1], color[2]);
    }
  };
  const fillEllipse = (cx, cy, rx, ry, color) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) setPixel(x, y, color[0], color[1], color[2]);
      }
    }
  };

  fillRect(0, 0, width, height, [238, 242, 232]);
  fillEllipse(128, 204, 76, 18, [190, 202, 174]);
  fillRect(116, 118, 140, 204, [112, 75, 41]);
  fillEllipse(128, 100, 70, 58, base);
  fillEllipse(92, 126, 44, 42, [58, 135, 68]);
  fillEllipse(164, 124, 48, 44, [76, 154, 72]);

  return `data:image/bmp;base64,${buffer.toString("base64")}`;
}
