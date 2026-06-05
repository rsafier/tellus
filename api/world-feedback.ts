import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
    const image = parseImageDataUrl(payload.imageDataUrl);
    const root = join(await generatedAssetRoot(), "world-feedback");
    await mkdir(root, { recursive: true });
    imagePath = join(root, `${Date.now()}-${randomUUID()}.${image.extension}`);
    await writeFile(imagePath, image.bytes);
    const prompt =
      typeof payload.prompt === "string" && payload.prompt.trim()
        ? payload.prompt.trim()
        : "Describe the visible Tellus world in 4-6 concise bullet points for an autonomous in-world agent. Focus on visible terrain, water, generated objects, spatial relationships, and anything that looks unfinished or surprising.";
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
