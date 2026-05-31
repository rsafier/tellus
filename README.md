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

## Skybox

To use the external skybox, place this file in `public/skybox/`:

```text
free_-_skybox_basic_sky.glb
```

Tellus will load it automatically and fall back to the procedural sky if it is
not present.

## Build

```bash
bun run build
```
