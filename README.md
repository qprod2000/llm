# llm

Aplikasi chat LLM sederhana (Next.js) dengan respons streaming. Memakai API key gratis lewat endpoint yang kompatibel dengan OpenAI, jadi penyedia bisa diganti hanya dengan mengubah environment variable.

## Environment variables

| Variabel | Fungsi |
|---|---|
| `LLM_API_KEY` | API key dari penyedia (wajib) |
| `LLM_BASE_URL` | Base URL API (default: Groq) |
| `LLM_MODEL` | Nama model |

Contoh nilai untuk Groq, Google Gemini, dan OpenRouter ada di `.env.example`.

Opsional:

| Variabel | Fungsi |
|---|---|
| `LLM_MODELS` | Daftar model cadangan (koma atau baris baru, maksimal 4). Dicoba berurutan sampai ada yang menjawab |
| `MCP_AUTH_TOKEN` | Mengaktifkan server MCP di `/api/mcp`. Klien wajib mengirim `Authorization: Bearer <token>` |
| `CHAT_TOOLS` | Isi `true` agar chat boleh memanggil tool (butuh model yang mendukung tool calling) |

## Model cadangan

Model gratis sering sibuk atau mengembalikan jawaban kosong. Isi `LLM_MODELS` dengan beberapa model; aplikasi mencobanya berurutan dan pindah ke model berikutnya jika model sebelumnya mengembalikan error (termasuk error di tengah stream), jawaban kosong, atau tidak mulai menjawab dalam 12 detik. Nama model yang jelas bukan model chat (embedding, rerank, safety, audio) dilewati. Model yang akhirnya menjawab tercatat di header respons `X-LLM-Model`. Jika `LLM_MODELS` kosong, dipakai `LLM_MODEL`.

## Tool dan MCP

Semua tool didefinisikan di satu tempat: `lib/tools.ts` (contoh: `get_current_time` dan `calculate`). Tool yang sama dipakai dua jalur:

- **Chat sebagai client:** dengan `CHAT_TOOLS=true`, model di `/api/chat` boleh memanggil tool. Jika provider menolak parameter tools, chat otomatis kembali ke mode streaming biasa. Saat tool aktif, jawaban dikirim utuh, tidak bertahap.
- **Server MCP:** `/api/mcp` (Streamable HTTP, tanpa sesi) membuka tool yang sama untuk klien MCP luar. Endpoint ini nonaktif sampai `MCP_AUTH_TOKEN` diisi.

Menambah tool baru: tambahkan satu objek ke array `tools` di `lib/tools.ts`. Tool langsung tersedia di chat dan di MCP.

Uji endpoint MCP:

```bash
curl -s https://<domain-anda>/api/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Untuk menyambungkan dari klien MCP, pakai alamat `https://<domain-anda>/api/mcp` dan kirim header `Authorization: Bearer <token>` (klien yang hanya mendukung OAuth tidak bisa dipakai dengan token statis ini).

## Jalankan lokal

```bash
npm install
cp .env.example .env.local   # lalu isi LLM_API_KEY
npm run dev
```

Buka http://localhost:3000.

## Deploy ke Vercel

1. Di Vercel: **Add New → Project**, pilih repo ini (framework terdeteksi otomatis sebagai Next.js).
2. Sebelum klik Deploy, buka **Environment Variables** dan isi `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.
3. Deploy. Setiap push ke `main` akan otomatis dideploy ulang.

Catatan: jangan pernah commit API key. `.env.local` sudah masuk `.gitignore`.
