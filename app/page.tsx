"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Doc = { id: string; name: string; size: number; uploadedAt: string };

type Msg = {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  model?: string; // model yang akhirnya menjawab
  tools?: string[]; // tool yang dipanggil model (jika ada)
  mode?: string; // "best" (calon + penilai) atau "partial" (mode terbaik tidak lengkap)
  candidates?: string[]; // model calon pada mode "best"
  skipped?: string[]; // model yang dilewati/gagal beserta alasannya
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

  // Login (hanya jika APP_PASSWORD diisi) dan dokumen
  const [auth, setAuth] = useState<{ required: boolean; authed: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsMsg, setDocsMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ name: string; length: number; text: string } | null>(null);

  async function showPreview(id: string) {
    setDocsMsg("");
    const res = await fetch(`/api/docs?id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setDocsMsg(data.error ?? "Gagal membaca dokumen.");
    setPreview(data);
  }

  async function loadDocs() {
    try {
      const res = await fetch("/api/docs");
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return setAuth({ required: true, authed: false });
      if (!res.ok) return setDocsMsg(data.error ?? `Gagal memuat dokumen (HTTP ${res.status})`);
      setDocs(data.docs ?? []);
      setSelected((sel) => sel.filter((id) => (data.docs ?? []).some((d: Doc) => d.id === id)));
      setDocsMsg("");
    } catch {
      setDocsMsg("Gagal memuat dokumen.");
    }
  }

  useEffect(() => {
    fetch("/api/login")
      .then((r) => r.json())
      .then((a) => setAuth(a))
      .catch(() => setAuth({ required: false, authed: true }));
  }, []);

  useEffect(() => {
    if (auth?.required && auth.authed) loadDocs();
  }, [auth]);

  async function login() {
    setLoginError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setPassword("");
      setAuth({ required: true, authed: true });
    } else {
      setLoginError((await res.json().catch(() => ({}))).error ?? "Login gagal.");
    }
  }

  async function logout() {
    await fetch("/api/login", { method: "DELETE" });
    setDocs([]);
    setSelected([]);
    setAuth({ required: true, authed: false });
  }

  async function upload(file: File) {
    setUploading(true);
    setDocsMsg("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/docs", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Unggah gagal (HTTP ${res.status})`);
      if (data.truncated) setDocsMsg("Dokumen terlalu panjang, hanya 200.000 karakter pertama yang disimpan.");
      await loadDocs();
      setSelected((sel) => [...sel, data.doc.id].slice(0, 5));
    } catch (e) {
      setDocsMsg(e instanceof Error ? e.message : "Unggah gagal.");
    } finally {
      setUploading(false);
    }
  }

  async function removeDoc(id: string) {
    const res = await fetch(`/api/docs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) setDocsMsg((await res.json().catch(() => ({}))).error ?? "Gagal menghapus.");
    await loadDocs();
  }

  function toggleDoc(id: string) {
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.length >= 5 ? sel : [...sel, id]));
  }

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
          docs: selected,
        }),
      });

      if (res.status === 401) {
        setAuth({ required: true, authed: false });
        throw new Error("Sesi login berakhir. Masuk lagi lalu kirim ulang.");
      }

      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }

      const model = res.headers.get("x-llm-model") ?? undefined;
      const tools = res.headers.get("x-llm-tools")?.split(",").filter(Boolean);
      const mode = res.headers.get("x-llm-mode") ?? undefined;
      const candidates = res.headers.get("x-llm-candidates")?.split(",").filter(Boolean);
      let skipped: string[] | undefined;
      try {
        const raw = res.headers.get("x-llm-skipped");
        skipped = raw ? decodeURIComponent(raw).split("\n").filter(Boolean) : undefined;
      } catch {}

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => [
          ...m.slice(0, -1),
          { role: "assistant", content: acc, model, tools, mode, candidates, skipped },
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

  if (auth?.required && !auth.authed) {
    return (
      <main className="app">
        <header>
          <span>LLM Chat</span>
        </header>
        <form
          className="login"
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
        >
          <input
            type="password"
            value={password}
            placeholder="Kata sandi"
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={!password}>
            Masuk
          </button>
          {loginError && <div className="login-error">{loginError}</div>}
        </form>
      </main>
    );
  }

  return (
    <main className="app">
      <header>
        <span>LLM Chat</span>
        <label className="toggle" title="Beberapa model menjawab, lalu satu penilai menggabungkan jawaban terbaik. Lebih lambat dan memakai lebih banyak kuota.">
          <input type="checkbox" checked={best} onChange={(e) => setBest(e.target.checked)} disabled={loading} />
          Jawaban terbaik (beberapa model)
        </label>
        {auth?.required && (
          <button onClick={() => setDocsOpen((o) => !o)}>
            Dokumen{selected.length ? ` (${selected.length} dipakai)` : ""}
          </button>
        )}
        <button onClick={() => setMessages([])} disabled={loading}>
          Percakapan baru
        </button>
        {auth?.required && <button onClick={logout}>Keluar</button>}
      </header>

      {auth?.required && docsOpen && (
        <section className="docs">
          <label className="upload">
            {uploading ? "Mengunggah…" : "Unggah berkas (pdf, txt, md, csv, json; maks 4 MB)"}
            <input
              type="file"
              accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.html,.htm"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) upload(f);
              }}
            />
          </label>
          {docsMsg && <div className="docs-msg">{docsMsg}</div>}
          {docs.length === 0 && !docsMsg && <div className="docs-empty">Belum ada dokumen.</div>}
          <ul>
            {docs.map((d) => (
              <li key={d.id}>
                <label>
                  <input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggleDoc(d.id)} />
                  <span className="doc-name">{d.name}</span>
                  <span className="doc-size">{Math.max(1, Math.round(d.size / 1024))} KB</span>
                </label>
                <span className="doc-actions">
                <button onClick={() => showPreview(d.id)} title="Lihat teks yang terbaca" aria-label={`Lihat teks ${d.name}`}>
                  Lihat
                </button>
                <button onClick={() => removeDoc(d.id)} title="Hapus dokumen" aria-label={`Hapus ${d.name}`}>
                  Hapus
                </button>
                </span>
              </li>
            ))}
          </ul>
          {preview && (
            <div className="preview">
              <div className="docs-hint">
                Teks terbaca dari {preview.name}: {preview.length.toLocaleString("id-ID")} karakter
                {preview.length > preview.text.length ? " (ditampilkan 6.000 pertama)" : ""}.{" "}
                <button onClick={() => setPreview(null)}>Tutup</button>
              </div>
              <pre>{preview.text}</pre>
            </div>
          )}
          <div className="docs-hint">Dokumen yang dicentang (maksimal 5) dipakai sebagai konteks tiap pertanyaan.</div>
        </section>
      )}

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
              {m.role === "assistant" && !m.error && m.content && m.skipped?.length ? (
                <details className="meta">
                  <summary>{m.skipped.length} model gagal/dilewati</summary>
                  <ul>
                    {m.skipped.map((x, k) => (
                      <li key={k}>{x}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
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
