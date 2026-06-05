import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatedAssetRoot } from "./generated-assets";

const stateFilename = "tellus-state.json";

async function statePath(): Promise<string> {
  const root = generatedAssetRoot();
  await mkdir(root, { recursive: true });
  return join(root, stateFilename);
}

export async function tellusStateHandler(request: Request): Promise<Response> {
  if (request.method === "GET") {
    try {
      return new Response(await readFile(await statePath(), "utf8"), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    } catch {
      return Response.json({ version: 1, terrainSculptOffsets: [] });
    }
  }

  if (request.method === "PUT" || request.method === "POST") {
    const body = await request.text();
    JSON.parse(body);
    const finalPath = await statePath();
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, finalPath);
    return Response.json({ ok: true });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

export default tellusStateHandler;
