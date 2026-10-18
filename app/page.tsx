"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Msg = {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  model?: string; // model yang akhirnya menjawab
  tools?: string[]; // tool yang dipanggil model (jika ada)
  mode?: string; // "best" (calon + penilai) atau "partial" (mode terbaik tidak lengkap)
  candidates?: string[]; // model calon pada mode "best"
};

function caption(m: Msg): string {
  if (m.mode === "best" && m.candidates?.length) {
    return `Jawaban terbaik dari ${m.candidates.length} model (${m.candidates.join(", ")}) · penilai: ${m.model}`;
  }
  if (m.mode === "partial") {
    return `${m.model} · mode terbaik tidak lengkap (hanya satu model atau penilai yang berhasil)`;
  }
  return `${m.model ?? ""}${m.tools?.length ? ` · tool: ${m.tools.join(", ")}` : ""}`;
}

export default function Page() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [best, setBest] = useState(false); // mode jawaban terbaik (beberapa model + penilai)
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    // Pesan error/kosong hanya untuk tampilan; jangan ikut dikirim ke model.
    const userMsg: Msg = { role: "user", content: text };
    const history: Msg[] = [...messages.filter((m) => !m.error && m.content.trim() !== ""), userMsg];
    setMessages([...messages, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content }) => ({ role, content })),
          mode: best ? "best" : "single",
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }

      const model = res.headers.get("x-llm-model") ?? undefined;
      const tools = res.headers.get("x-llm-tools")?.split(",").filter(Boolean);
      const mode = res.headers.get("x-llm-mode") ?? undefined;
      const candidates = res.headers.get("x-llm-candidates")?.split(",").filter(Boolean);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => [
          ...m.slice(0, -1),
          { role: "assistant", content: acc, model, tools, mode, candidates },
        ]);
      }
      if (!acc.trim()) {
        setMessages((m) => [
          ...m.slice(0, -1),
          { role: "assistant", content: "Tidak ada jawaban dari server. Coba kirim ulang.", error: true },
        ]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Terjadi kesalahan";
      setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: msg, error: true }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <header>
        <span>LLM Chat</span>
        <label className="toggle" title="Beberapa model menjawab, lalu satu penilai menggabungkan jawaban terbaik. Lebih lambat dan memakai lebih banyak kuota.">
          <input type="checkbox" checked={best} onChange={(e) => setBest(e.target.checked)} disabled={loading} />
          Jawaban terbaik (beberapa model)
        </label>
        <button onClick={() => setMessages([])} disabled={loading}>
          Percakapan baru
        </button>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">Tanyakan apa saja untuk memulai percakapan.</div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const plain = m.role === "user" || m.error;
          return (
            <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
              {plain ? (
                m.content
              ) : m.content ? (
                <div className="md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                    }}
                  >
                    {m.content}
                  </ReactMarkdown>
                </div>
              ) : loading && isLast ? (
                best ? "Menunggu beberapa model…" : "…"
              ) : (
                ""
              )}
              {m.role === "assistant" && !m.error && m.content && (m.model || m.tools?.length) && (
                <div className="meta">{caption(m)}</div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={1}
          value={input}
          placeholder="Tulis pesan… (Enter kirim, Shift+Enter baris baru)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Kirim
        </button>
      </form>
    </main>
  );
}
