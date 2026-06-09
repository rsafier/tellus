import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { generatedAssetRoot } from "./generated-assets";

interface McpToolContent {
  type?: string;
  text?: string;
}

interface McpResponse {
  id?: number;
  result?: {
    content?: McpToolContent[];
  };
  error?: {
    message?: string;
  };
}

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxImageBytes = 4 * 1024 * 1024;
const mcpTimeoutMs = 45_000;

function zAiApiKey(): string {
  const apiKey =
    process.env.Z_AI_API_KEY?.trim() ||
    process.env.ZAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ZAI_API_KEY is required for Tellus world feedback");
  }
  return apiKey;
}

function parseImageDataUrl(dataUrl: unknown): {
  bytes: Buffer;
  extension: string;
} {
  if (typeof dataUrl !== "string") {
    throw new Error("imageDataUrl must be a string");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(
    dataUrl,
  );
  if (!match) {
    throw new Error("imageDataUrl must be a PNG, JPEG, or WebP data URL");
  }
  const mime = match[1].toLowerCase();
  if (!supportedImageTypes.has(mime)) {
    throw new Error(`Unsupported image type: ${mime}`);
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (bytes.byteLength === 0) {
    throw new Error("imageDataUrl is empty");
  }
  if (bytes.byteLength > maxImageBytes) {
    throw new Error("imageDataUrl is larger than 4 MB");
  }
  return {
    bytes,
    extension: mime === "image/jpeg" ? "jpg" : mime.split("/")[1],
  };
}

function mcpRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function zaiMcpCommand(): { command: string; args: string[] } {
  const configured = process.env.ZAI_MCP_COMMAND?.trim();
  if (configured) return { command: configured, args: [] };
  return {
    command: process.execPath,
    args: [join(process.cwd(), "node_modules", ".bin", "zai-mcp-server")],
  };
}

async function analyzeImageWithMcp(
  imagePath: string,
  prompt: string,
): Promise<string> {
  const apiKey = zAiApiKey();
  const mcp = zaiMcpCommand();
  const child = spawn(mcp.command, mcp.args, {
    env: {
      ...process.env,
      Z_AI_API_KEY: apiKey,
      Z_AI_MODE: process.env.Z_AI_MODE?.trim() || "ZAI",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, mcpTimeoutMs);

  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timedOut) {
        reject(new Error("Z.ai vision MCP timed out"));
        return;
      }
      if (code && code !== 0) {
        reject(
          new Error(
            `Z.ai vision MCP exited with code ${code}${signal ? ` (${signal})` : ""}`,
          ),
        );
        return;
      }
      resolve();
    });
  });

  try {
    child.stdin.write(
      mcpRequest(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tellus-world-feedback", version: "0.1.0" },
      }),
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`,
    );
    child.stdin.write(
      mcpRequest(2, "tools/call", {
        name: "analyze_image",
        arguments: {
          image_source: imagePath,
          prompt,
        },
      }),
    );
    child.stdin.end();
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  try {
    await exit;
  } catch (error) {
    const cleanStderr = stderr
      .split(/\r?\n/)
      .filter((line) => line && !line.includes("npm notice"))
      .slice(-4)
      .join(" ");
    throw new Error(
      cleanStderr ||
        (error instanceof Error
          ? error.message
          : "Z.ai vision MCP process failed"),
    );
  } finally {
    clearTimeout(timeout);
  }

  const responses = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line): McpResponse[] => {
      try {
        return [JSON.parse(line) as McpResponse];
      } catch {
        return [];
      }
    });
  const response = responses.find((item) => item.id === 2);
  if (response?.error?.message) {
    throw new Error(response.error.message);
  }
  const text = response?.result?.content
    ?.map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text?.startsWith("Error:")) {
    throw new Error(text);
  }
  if (!text) {
    const cleanStderr = stderr
      .split(/\r?\n/)
      .filter((line) => line && !line.includes("npm notice"))
      .slice(-4)
      .join(" ");
    throw new Error(cleanStderr || "Z.ai vision MCP returned no summary");
  }
  return text;
}

// ── Hyades vision ─────────────────────────────────────────────────────────────
// Opt-in (TELLUS_VISION_BACKEND=hyades): replace the Z.ai vision MCP with a direct multimodal call to the
// Hyades OpenAI-compatible gateway (/v1/chat/completions: an image_url data URI + the prompt). Hyades
// normalizes provider output. Model via HYADES_VISION_MODEL (default holo3.1).
function hyadesVisionEnabled(): boolean {
  return (process.env.TELLUS_VISION_BACKEND ?? "").trim().toLowerCase() === "hyades";
}

async function analyzeImageWithHyades(imageDataUrl: string, prompt: string): Promise<string> {
  const apiKey = process.env.HYADES_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("HYADES_API_KEY is required for Tellus world feedback (TELLUS_VISION_BACKEND=hyades)");
  }
  const base = (process.env.HYADES_LLM_BASE?.trim() || "https://hyades.gnostr.cloud/v1").replace(/\/+$/, "");
  const model = process.env.HYADES_VISION_MODEL?.trim() || "holo3.1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.HYADES_VISION_MAX_TOKENS || 400),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
  });
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(msg || `Hyades vision failed (${res.status})`);
  }
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Hyades vision returned no summary");
  return text;
}

export async function worldFeedbackHandler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let imagePath = "";
  try {
    const payload = (await request.json()) as {
      imageDataUrl?: unknown;
      prompt?: unknown;
    };
    // Validate format/size regardless of backend.
    const image = parseImageDataUrl(payload.imageDataUrl);
    const prompt =
      typeof payload.prompt === "string" && payload.prompt.trim()
        ? payload.prompt.trim()
        : "Describe the visible Tellus world in 4-6 concise bullet points for an autonomous in-world agent. Focus on visible terrain, water, generated objects, spatial relationships, and anything that looks unfinished or surprising.";

    // Hyades vision path: downscale (vision models choke on multi-MB data URIs), then a single multimodal
    // call — no temp file / MCP subprocess.
    if (hyadesVisionEnabled()) {
      const small = await sharp(image.bytes)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const dataUrl = `data:image/jpeg;base64,${small.toString("base64")}`;
      const summary = await analyzeImageWithHyades(dataUrl, prompt);
      return Response.json({ summary });
    }

    // Legacy Z.ai vision MCP path (writes a temp file the MCP reads).
    const root = join(await generatedAssetRoot(), "world-feedback");
    await mkdir(root, { recursive: true });
    imagePath = join(root, `${Date.now()}-${randomUUID()}.${image.extension}`);
    await writeFile(imagePath, image.bytes);
    const summary = await analyzeImageWithMcp(imagePath, prompt);
    return Response.json({ summary });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Tellus world feedback failed",
      },
      { status: 502 },
    );
  } finally {
    if (imagePath) {
      await rm(imagePath, { force: true }).catch(() => undefined);
    }
  }
}

export default worldFeedbackHandler;
