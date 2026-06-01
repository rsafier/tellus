const ALLOWED_GRADIO_HOSTS = new Set([
  "192.168.1.177:43839",
  "localhost:43839",
  "127.0.0.1:43839",
]);

export async function gradioFileHandler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawUrl = url.searchParams.get("url");
  if (!rawUrl) {
    return new Response("Missing url", { status: 400 });
  }

  const target = new URL(rawUrl);
  if (!ALLOWED_GRADIO_HOSTS.has(target.host)) {
    return new Response("Blocked Gradio file host", { status: 403 });
  }

  const upstream = await fetch(target);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "model/gltf-binary",
      "Cache-Control": "no-store",
    },
  });
}

export default gradioFileHandler;
