import { callTool, tools } from "../../../lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;
const MAX_TOOL_ROUNDS = 5;
const SYSTEM_PROMPT = "Kamu asisten yang membantu. Jawab dalam bahasa yang dipakai pengguna.";

const openAiTools = tools.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

class UpstreamError extends Error {
  constructor(
    public status: number,
    detail: string,
  ) {
    const hint = status === 429 ? " (batas penggunaan gratis tercapai, coba lagi sebentar)" : "";
    super(`Provider error ${status}${hint}: ${detail.slice(0, 300)}`);
  }
}

type ToolCall = { id: string; function: { name: string; arguments?: string } };

// Mode tool: model boleh memanggil tool di lib/tools.ts. Tidak di-stream (jawaban dikirim utuh).
// Mengembalikan null bila provider/model menolak parameter `tools`, supaya pemanggil
// bisa kembali ke mode streaming biasa.
async function chatWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  history: { role: string; content: string }[],
): Promise<string | null> {
  const convo: Record<string, unknown>[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: convo, tools: openAiTools, tool_choice: "auto" }),
    });

    if (!res.ok) {
      if (round === 0 && [400, 404, 422].includes(res.status)) return null;
      throw new UpstreamError(res.status, await res.text().catch(() => ""));
    }

    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const calls: ToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

    if (calls.length === 0) {
      const content = typeof msg?.content === "string" ? msg.content.trim() : "";
      return content || "Model tidak mengembalikan jawaban. Coba kirim ulang atau ganti LLM_MODEL.";
    }

    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // argumen rusak: biarkan kosong, tool akan melaporkan parameter yang kurang
      }
      const { text } = await callTool(call.function.name, args);
      convo.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  return "Batas pemanggilan tool tercapai sebelum jawaban akhir selesai.";
}

export async function POST(req: Request) {
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";

  if (!apiKey) {
    return new Response("LLM_API_KEY belum diatur di environment variables.", { status: 500 });
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Body request tidak valid.", { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (messages.length === 0) {
    return new Response("Pesan kosong.", { status: 400 });
  }

  if (process.env.CHAT_TOOLS === "true") {
    try {
      const answer = await chatWithTools(baseUrl, apiKey, model, messages);
      if (answer !== null) {
        return new Response(answer, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      // provider menolak tools -> lanjut ke mode streaming biasa di bawah
    } catch (err) {
      const status = err instanceof UpstreamError ? 502 : 500;
      const text = err instanceof Error ? err.message : "Terjadi kesalahan.";
      return new Response(text, { status });
    }
  }

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    const hint = upstream.status === 429 ? " (batas penggunaan gratis tercapai, coba lagi sebentar)" : "";
    return new Response(`Provider error ${upstream.status}${hint}: ${detail.slice(0, 300)}`, {
      status: 502,
    });
  }

  // Ubah stream SSE ala OpenAI menjadi stream teks biasa.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let emitted = false;
  let providerError = "";
  let sawReasoning = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              // Sebagian provider (mis. OpenRouter) mengirim error di tengah stream dengan HTTP 200.
              if (parsed?.error) {
                providerError =
                  typeof parsed.error === "string"
                    ? parsed.error
                    : (parsed.error.message ?? JSON.stringify(parsed.error));
                continue;
              }
              const choice = parsed?.choices?.[0];
              const delta = choice?.delta?.content;
              if (delta) {
                emitted = true;
                controller.enqueue(encoder.encode(delta));
              } else if (choice?.delta?.reasoning || choice?.delta?.reasoning_content) {
                sawReasoning = true;
              }
            } catch {
              // abaikan baris SSE yang bukan JSON
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      if (!emitted) {
        // Jangan biarkan gelembung kosong: jelaskan apa yang terjadi.
        const reason = providerError
          ? `Provider mengembalikan error: ${providerError.slice(0, 300)}`
          : sawReasoning
            ? "Model hanya menghasilkan proses berpikir tanpa jawaban akhir. Coba model lain atau kirim ulang."
            : "Model tidak mengembalikan jawaban. Model gratis kadang sibuk atau tidak tersedia; coba kirim ulang atau ganti LLM_MODEL.";
        console.error("[chat] jawaban kosong:", reason);
        controller.enqueue(encoder.encode(reason));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
