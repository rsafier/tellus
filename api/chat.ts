function chatHeaders(apiKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
}

function zaiProviderConfig(): { baseUrl: string; apiKey: string; name: string } {
  const apiKey = process.env.ZAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ZAI_API_KEY is required for Tellus agent chat");
  }

  return {
    baseUrl:
      process.env.ZAI_BASE_URL?.trim() ??
      "https://api.z.ai/api/coding/paas/v4",
    apiKey,
    name: "Z.ai",
  };
}

async function chatRequestBody(request: Request): Promise<string> {
  const payload = (await request.json()) as Record<string, unknown>;
  const model = process.env.ZAI_MODEL?.trim();
  if (model) payload.model = model;
  if (!payload.thinking) {
    payload.thinking = {
      type: process.env.ZAI_THINKING_TYPE?.trim() || "disabled",
    };
  }
  return JSON.stringify(payload);
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const provider = zaiProviderConfig();
    const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(provider.apiKey),
      body: await chatRequestBody(request),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Z.ai proxy failed",
      },
      { status: 502 },
    );
  }
}
