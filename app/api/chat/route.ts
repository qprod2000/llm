import { callTool, tools } from "../../../lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;
const MAX_TOOL_ROUNDS = 5;
const MAX_MODELS = 4; // jumlah model yang dicoba berurutan
const FIRST_TOKEN_TIMEOUT_MS = 12_000; // model yang tidak mulai menjawab dalam waktu ini dilewati
const TOOL_CALL_TIMEOUT_MS = 25_000;
const TIME_BUDGET_MS = 45_000; // berhenti mencoba model lain jika sudah selama ini (batas fungsi 60 dtk)
const SYSTEM_PROMPT = "Kamu asisten yang membantu. Jawab dalam bahasa yang dipakai pengguna.";

// Model yang jelas bukan model chat (embedding, rerank, moderasi, audio) dilewati.
const NON_CHAT_MODEL = /embed|rerank|safety|guard|moderation|audio|tts|whisper/i;

const openAiTools = tools.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

// LLM_MODELS (atau LLM_MODEL) boleh berisi satu atau beberapa nama model, dipisah koma atau baris baru.
// Urutannya = urutan prioritas; model berikutnya dipakai jika model sebelumnya gagal.
function parseModels(): string[] {
  const raw = process.env.LLM_MODELS?.trim() || process.env.LLM_MODEL || "";
  const list = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !NON_CHAT_MODEL.test(s));
  const unique = [...new Set(list)];
  return (unique.length ? unique : ["llama-3.3-70b-versatile"]).slice(0, MAX_MODELS);
}

function providerMessage(status: number, detail: string): string {
  const hint = status === 429 ? " (batas penggunaan gratis tercapai)" : "";
  return `Provider error ${status}${hint}: ${detail.slice(0, 200)}`;
}

type ToolCall = { id: string; function: { name: string; arguments?: string } };

// Mode tool: model boleh memanggil tool di lib/tools.ts. Tidak di-stream (jawaban dikirim utuh).
// Mengembalikan null bila provider/model menolak parameter `tools` atau gagal, supaya pemanggil
// bisa kembali ke mode streaming biasa (yang punya fallback model).
async function chatWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  history: { role: string; content: string }[],
): Promise<{ text: string; toolsUsed: string[] } | null> {
  const convo: Record<string, unknown>[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: convo, tools: openAiTools, tool_choice: "auto" }),
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("[chat] mode tool gagal:", providerMessage(res.status, await res.text().catch(() => "")));
      return null;
    }

    const data = await res.json();
    if (data?.error) {
      console.error("[chat] mode tool error:", JSON.stringify(data.error).slice(0, 200));
      return null;
    }
    const msg = data?.choices?.[0]?.message;
    const calls: ToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

    if (calls.length === 0) {
      const content = typeof msg?.content === "string" ? msg.content.trim() : "";
      return content ? { text: content, toolsUsed } : null; // kosong -> biarkan mode streaming/model lain mencoba
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
      // Hanya nama tool yang benar-benar ada yang dicatat (aman dipakai sebagai nilai header).
      if (tools.some((t) => t.name === call.function.name) && !toolsUsed.includes(call.function.name)) {
        toolsUsed.push(call.function.name);
      }
      convo.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  return { text: "Batas pemanggilan tool tercapai sebelum jawaban akhir selesai.", toolsUsed };
}

type StreamState = { providerError: string; sawReasoning: boolean };

// Mengubah stream SSE ala OpenAI menjadi potongan teks.
async function* sseDeltas(body: ReadableStream<Uint8Array>, state: StreamState): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
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
            state.providerError =
              typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error));
            continue;
          }
          const delta = parsed?.choices?.[0]?.delta;
          if (delta?.content) yield delta.content as string;
          else if (delta?.reasoning || delta?.reasoning_content) state.sawReasoning = true;
        } catch {
          // abaikan baris SSE yang bukan JSON
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

type Opened = { ok: true; first: string; rest: AsyncGenerator<string, void, undefined> } | { ok: false; error: string };

// Membuka stream ke satu model dan menunggu potongan teks pertama. Gagal bila: HTTP error,
// error di tengah stream sebelum ada teks, jawaban kosong, atau tidak mulai menjawab tepat waktu.
async function openStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
): Promise<Opened> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FIRST_TOKEN_TIMEOUT_MS);
  const state: StreamState = { providerError: "", sawReasoning: false };
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      }),
      signal: ac.signal,
    });

    if (!res.ok || !res.body) {
      return { ok: false, error: providerMessage(res.status, await res.text().catch(() => "")) };
    }

    const gen = sseDeltas(res.body, state);
    const first = await gen.next();
    if (first.done) {
      const error = state.providerError
        ? `Provider mengembalikan error: ${state.providerError.slice(0, 200)}`
        : state.sawReasoning
          ? "Model hanya menghasilkan proses berpikir tanpa jawaban akhir."
          : "Model tidak mengembalikan jawaban.";
      return { ok: false, error };
    }
    return { ok: true, first: first.value, rest: gen };
  } catch (err) {
    const error = ac.signal.aborted
      ? `Tidak mulai menjawab dalam ${FIRST_TOKEN_TIMEOUT_MS / 1000} detik.`
      : `Gagal menghubungi provider: ${err instanceof Error ? err.message : "kesalahan tidak dikenal"}`;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

function toByteStream(first: string, rest: AsyncGenerator<string, void, undefined>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(first));
      try {
        for await (const chunk of rest) controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
}

const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const startedAt = Date.now();
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const apiKey = process.env.LLM_API_KEY;

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

  const models = parseModels();

  // Mode tool hanya mencoba model pertama; jika gagal, lanjut ke mode streaming (dengan fallback model).
  if (process.env.CHAT_TOOLS === "true") {
    try {
      const answer = await chatWithTools(baseUrl, apiKey, models[0], messages);
      if (answer !== null) {
        const headers: Record<string, string> = { ...TEXT_HEADERS, "X-LLM-Model": models[0] };
        if (answer.toolsUsed.length) headers["X-LLM-Tools"] = answer.toolsUsed.join(",");
        return new Response(answer.text, { headers });
      }
    } catch (err) {
      console.error("[chat] mode tool error:", err instanceof Error ? err.message : err);
    }
  }

  const failures: string[] = [];
  for (const model of models) {
    if (failures.length > 0 && Date.now() - startedAt > TIME_BUDGET_MS) {
      failures.push("(waktu habis, model berikutnya tidak dicoba)");
      break;
    }
    const opened = await openStream(baseUrl, apiKey, model, messages);
    if (opened.ok) {
      return new Response(toByteStream(opened.first, opened.rest), {
        headers: { ...TEXT_HEADERS, "X-LLM-Model": model },
      });
    }
    console.error(`[chat] ${model} gagal: ${opened.error}`);
    failures.push(`${model}: ${opened.error}`);
  }

  return new Response(
    `Semua model gagal dicoba. Biasanya model gratis sedang sibuk; coba lagi sebentar.\n\n${failures.join("\n")}`,
    { status: 502 },
  );
}
