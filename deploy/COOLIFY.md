# Deploying Tellus on Coolify (auto-deploy on git push)

Tellus is a plain Dockerfile app (Bun: builds the SPA into `dist/`, serves it + the `/api/*` routes
on port 3000), so Coolify can build and auto-deploy it straight from this repo. The **world** lives in
the Hyades cluster (`worldApiBase` in `public/tellus-config.json` → `https://hyades.gnostr.cloud`), so a
Coolify deployment only serves the SPA + the server-side `/api/*` endpoints (chat, generate-3d, world-feedback,
tellus-state) — which proxy to Hyades using the env vars below.

## One-time setup in Coolify

1. **New Resource → Application → Public/Private Repository** → point it at this repo
   (`DavinciDreams/tellus`), branch `main`.
2. **Build Pack: Dockerfile** (the repo's `Dockerfile` is used as-is). **Port: 3000.**
3. **Environment variables** (Settings → Environment Variables):
   - `HYADES_API_KEY` = a Hyades bearer with the `generate3d` capability **(mark as secret)** — the only
     required one; without it `/api/chat`, `/api/generate-3d`, `/api/world-feedback` return 503.
   - Optional (these already have correct defaults baked into the API handlers, set only to override):
     `HYADES_LLM_BASE=https://hyades.gnostr.cloud/v1`, `HYADES_LLM_MODEL=glm-5.1`,
     `HYADES_VISION_MODEL=holo3.1`, `HYADES_3D_API_BASE=https://hyades.gnostr.cloud`,
     `HYADES_BASE_URL=https://hyades.gnostr.cloud`, `NODE_ENV=production`.
   - The browser config (`worldApiBase`, providers, day/night, …) ships in `public/tellus-config.json`
     and is baked at build — no env needed. `apiBase` is `""` (same-origin), so the SPA calls this
     deployment's own `/api/*`. To override per-deploy without a rebuild, mount a file over
     `/app/dist/tellus-config.json` (Coolify → Storages → File Mount).
4. **Domain**: set the FQDN (Coolify provisions TLS via its Traefik + Let's Encrypt). The world traffic
   goes browser→Hyades directly, so the domain only needs to reach this container.
5. **Health check**: HTTP `GET /health` on port 3000.
6. **Auto-deploy**: enable **"Automatic Deployment"** and add the GitHub webhook Coolify shows (or connect
   the Coolify GitHub App). Every push to `main` then rebuilds + redeploys with zero-downtime.

## Notes

- `HYADES_API_KEY` must be `generate3d`-capable — provision it on the Hyades side (`/admin/keys`).
- Build is single-arch for the Coolify host (simpler than the multi-arch k3s image); the Dockerfile is
  identical.
- This is independent of the in-cluster k3s deployment (`deploy/k8s/tellus.yaml`); run either or both.
  Both serve their own `/api/*` and point the world at the same Hyades cluster.
