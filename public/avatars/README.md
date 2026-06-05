# Avatar Assets

Agent avatars are optional and are not bundled by default. Prefer remote HTTPS
URLs for deployed builds, or place local GLB/VRM files here for development and
point the Tellus env vars at them:

```text
VITE_TELLUS_JOHNNY_AVATAR_URL=/avatars/johnny.glb
VITE_TELLUS_MIRA_AVATAR_URL=/avatars/mira.glb
VITE_TELLUS_SOL_AVATAR_URL=/avatars/sol.glb
```

Remote HTTPS URLs also work.
