import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const hyadesBaseUrl = env.HYADES_BASE_URL ?? "http://192.168.1.187";
  const hyadesApiKey = env.HYADES_API_KEY;

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 3344,
      strictPort: true,
      proxy: hyadesApiKey
        ? {
            "/api/chat": {
              target: hyadesBaseUrl,
              changeOrigin: true,
              rewrite: () => "/v1/chat/completions",
              headers: {
                Authorization: `Bearer ${hyadesApiKey}`,
              },
            },
            "/api/tts": {
              target: hyadesBaseUrl,
              changeOrigin: true,
              rewrite: () => "/tts",
              headers: {
                Authorization: `Bearer ${hyadesApiKey}`,
              },
            },
          }
        : undefined,
    },
  };
});
