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

## Pixel3D / Asset Forge

Tellus can call an Asset Forge instance for Pixel3D generation. Configure the
browser-visible API base URL:

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

For deploys where you do not want to rebuild just to change asset URLs, copy
`public/tellus-config.example.json` to `public/tellus-config.json` or place a
`tellus-config.json` file next to the built app. Tellus reads it at runtime:

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

The real `tellus-config.json` file is ignored by git so production URLs can be
managed outside the repo.

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

To use the external skybox, place this file in `public/skybox/`:

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
