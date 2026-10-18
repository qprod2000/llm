# llm

Aplikasi chat LLM sederhana (Next.js) dengan respons streaming. Memakai API key gratis lewat endpoint yang kompatibel dengan OpenAI, jadi penyedia bisa diganti hanya dengan mengubah environment variable.

## Environment variables

| Variabel | Fungsi |
|---|---|
| `LLM_API_KEY` | API key dari penyedia (wajib) |
| `LLM_BASE_URL` | Base URL API (default: Groq) |
| `LLM_MODEL` | Nama model |

Contoh nilai untuk Groq, Google Gemini, dan OpenRouter ada di `.env.example`.

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
