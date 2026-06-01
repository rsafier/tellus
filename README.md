# Tellus

Tellus is a tiny WebGPU AI terrarium: a floating disc world with a mountain,
terrain, water, an avatar, and a few autonomous agents that can `generate` and
`interact` with objects in the scene.

## Requirements

- Bun
- A browser with WebGPU enabled

## Development

```bash
bun install
bun run dev
```

Open <http://localhost:3344/>.

## 3D Generation

Tellus supports three generation modes:

```text
VITE_TELLUS_GENERATION_PROVIDER=instantmesh-gradio
VITE_TELLUS_GENERATION_PROVIDER=asset-forge
VITE_TELLUS_GENERATION_PROVIDER=local
```

`local` keeps the fast procedural meshes. `asset-forge` calls the Asset Forge
pipeline. `instantmesh-gradio` calls a direct InstantMesh Gradio adapter through
Tellus' own `/api/generate-3d` endpoint.

For direct InstantMesh:

```text
INSTANTMESH_GRADIO_BASE_URL=https://your-instantmesh-gradio.example.com
INSTANTMESH_SAMPLE_STEPS=30
```

For deployed Vercel/Coolify builds, `INSTANTMESH_GRADIO_BASE_URL` must be a URL
that the deployed server can reach. A private LAN address such as
`http://192.168.x.x:43839` only works from machines on that same network.

InstantMesh is image-to-3D, while Tellus agents speak in text prompts. The
adapter creates a simple concept image from the prompt, sends it to InstantMesh,
and returns a proxied GLB URL that the WebGPU scene can load.

For Asset Forge / Pixel3D, configure the browser-visible API base URL:

```bash
cp .env.example .env.local
```

```text
VITE_ASSET_FORGE_API_BASE=https://your-asset-forge.example.com
```

When set, generated objects are queued through:

```text
POST /api/generation/pipeline
GET /api/generation/pipeline/:pipelineId
```

Asset Forge should be configured server-side with its Pixel3D env vars, such as
`GENERATION_3D_PROVIDER=pixel3d-gradio` and `PIXEL3D_GRADIO_BASE_URL`.

If the API is unset or fails, Tellus keeps using its local procedural meshes.

## Live Agents

Tellus can run its agents through an OpenAI-compatible Hyades/Nemotron endpoint
without exposing the bearer key in browser code. Local dev uses the Vite proxy;
Vercel uses the `/api/chat` serverless function.

```text
HYADES_BASE_URL=http://192.168.1.187
HYADES_API_KEY=sk-hy-...
VITE_TELLUS_AGENT_MODEL=GLM-5.1
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
ZAI_API_KEY=...
ZAI_MODEL=GLM-5.1
```

When configured, Johnny, Mira, and Sol ask `/api/chat` for their next
`generate()` prompt. If the endpoint is unavailable, they fall back to the local
scripted behavior. `/api/tts` is also proxied for the Hyades TTS endpoint, ready
for a later voice pass.

Tellus reads `public/tellus-config.json` at runtime. The committed file is
deploy-safe and intentionally has no local asset paths, so Vercel can build even
when large local files are not in git. For machine-local overrides, create
`public/tellus-config.local.json`; it is ignored by git and loaded after the
committed config:

```json
{
  "assetForgeApiBase": "https://your-asset-forge.example.com",
  "skyboxUrl": "https://cdn.example.com/tellus/sky.glb",
  "avatars": {
    "johnny": "https://cdn.example.com/tellus/johnny.glb",
    "mira": "https://cdn.example.com/tellus/mira.glb",
    "sol": "https://cdn.example.com/tellus/sol.glb"
  }
}
```

On Vercel, set `VITE_ASSET_FORGE_API_BASE` and the `VITE_TELLUS_*_AVATAR_URL`
variables when you want the URLs baked into a build, or replace
`public/tellus-config.json` during deployment if your hosting setup supports
runtime config injection.

## Agent Avatars

Set avatar URLs with:

```text
VITE_TELLUS_JOHNNY_AVATAR_URL=/avatars/johnny.glb
VITE_TELLUS_MIRA_AVATAR_URL=/avatars/mira.glb
VITE_TELLUS_SOL_AVATAR_URL=/avatars/sol.glb
```

Files can live in `public/avatars/`, or the values can be remote HTTPS URLs.
Large `.glb`, `.gltf`, and `.vrm` files in `public/avatars/` are ignored by git.
For production, prefer hosting them from object storage, a CDN, or a mounted
volume served by your web server.

## Skybox

To use the external skybox locally, place this file in `public/skybox/` and point
`public/tellus-config.local.json` at it:

```text
free_-_skybox_basic_sky.glb
```

Tellus will load it automatically and fall back to the procedural sky if it is
not present.

Large skybox files in `public/skybox/` are ignored by git.

## Build

```bash
bun run build
```
