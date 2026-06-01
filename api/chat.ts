function chatHeaders(apiKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
}

function chatProviderConfig(): { baseUrl: string; apiKey: string; name: string } {
  const zaiApiKey = process.env.ZAI_API_KEY;
  if (zaiApiKey) {
    return {
      baseUrl:
        process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4",
      apiKey: zaiApiKey,
      name: "Z.ai",
    };
  }

  const apiKey = process.env.HYADES_API_KEY;
  if (!apiKey) {
    throw new Error("ZAI_API_KEY or HYADES_API_KEY is required");
  }
  const hyadesBaseUrl = process.env.HYADES_BASE_URL ?? "http://192.168.1.187/v1";
  const normalizedHyadesBaseUrl = /\/v\d+\/?$/i.test(hyadesBaseUrl)
    ? hyadesBaseUrl
    : `${hyadesBaseUrl.replace(/\/+$/, "")}/v1`;
  return {
    baseUrl: normalizedHyadesBaseUrl,
    apiKey,
    name: "Hyades",
  };
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const provider = chatProviderConfig();
  try {
    const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(provider.apiKey),
      body: await request.text(),
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
            : `${provider.name} proxy failed`,
      },
      { status: 502 },
    );
  }
}
