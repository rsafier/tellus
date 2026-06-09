function chatHeaders(apiKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
}

interface LlmProvider {
  baseUrl: string;
  apiKey: string;
  name: string;
  hyades: boolean;
  model?: string;
}

function llmProviderConfig(): LlmProvider {
  // Opt-in (TELLUS_LLM_BACKEND=hyades): route Tellus LLM actions through the Hyades OpenAI-compatible
  // gateway (/v1/chat/completions) using the same server-side key the other Hyades proxies use.
  if ((process.env.TELLUS_LLM_BACKEND ?? "").trim().toLowerCase() === "hyades") {
    const apiKey = process.env.HYADES_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("HYADES_API_KEY is required for Tellus LLM (TELLUS_LLM_BACKEND=hyades)");
    }
    return {
      baseUrl: (process.env.HYADES_LLM_BASE?.trim() || "https://hyades.gnostr.cloud/v1").replace(/\/+$/, ""),
      apiKey,
      name: "Hyades",
      hyades: true,
      model: process.env.HYADES_LLM_MODEL?.trim() || process.env.ZAI_MODEL?.trim() || "glm-5.1",
    };
  }

  const apiKey = process.env.ZAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ZAI_API_KEY is required for Tellus agent chat");
  }
  return {
    baseUrl: (process.env.ZAI_BASE_URL?.trim() ?? "https://api.z.ai/api/coding/paas/v4").replace(/\/+$/, ""),
    apiKey,
    name: "Z.ai",
    hyades: false,
    model: process.env.ZAI_MODEL?.trim(),
  };
}

async function chatRequestBody(request: Request, provider: LlmProvider): Promise<string> {
  const payload = (await request.json()) as Record<string, unknown>;
  if (provider.model) payload.model = provider.model;
  // The `thinking` control is Z.ai-specific; the Hyades/OpenAI-compatible gateway doesn't take it.
  if (!provider.hyades && !payload.thinking) {
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
    const provider = llmProviderConfig();
    const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(provider.apiKey),
      body: await chatRequestBody(request, provider),
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
        error: error instanceof Error ? error.message : "LLM proxy failed",
      },
      { status: 502 },
    );
  }
}
