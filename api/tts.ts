function hyadesHeaders(): Headers {
  const apiKey = process.env.HYADES_API_KEY;
  if (!apiKey) {
    throw new Error("HYADES_API_KEY is not configured");
  }
  return new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const baseUrl = process.env.HYADES_BASE_URL ?? "http://192.168.1.187";
  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: hyadesHeaders(),
      body: await request.text(),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "text/event-stream",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Hyades TTS proxy failed",
      },
      { status: 502 },
    );
  }
}
