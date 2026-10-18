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
| `APP_PASSWORD` | Kata sandi akses. Wajib untuk fitur dokumen; jika diisi, chat juga meminta login |
| `BLOB_READ_WRITE_TOKEN` | Terisi otomatis saat store Vercel Blob dihubungkan ke proyek (tempat dokumen disimpan) |

## Tampilan

Jawaban dirender sebagai markdown (teks tebal, daftar, tabel, blok kode, tautan). HTML mentah dalam jawaban tidak dijalankan dan tautan berbahaya dinetralkan. Di bawah tiap jawaban tampil nama model yang menjawab, dan nama tool jika model memanggil tool (`model · tool: calculate`).

## Model cadangan

Model gratis sering sibuk atau mengembalikan jawaban kosong. Isi `LLM_MODELS` dengan beberapa model; aplikasi mencobanya berurutan dan pindah ke model berikutnya jika model sebelumnya mengembalikan error (termasuk error di tengah stream), jawaban kosong, atau tidak mulai menjawab dalam 12 detik. Nama model yang jelas bukan model chat (embedding, rerank, safety, audio) dilewati. Model yang akhirnya menjawab tercatat di header respons `X-LLM-Model`. Jika `LLM_MODELS` kosong, dipakai `LLM_MODEL`.

## Mode "Jawaban terbaik" (opsional)

Centang **Jawaban terbaik (beberapa model)** di header. Alurnya:

1. Tiga model teratas di `LLM_MODELS` menjawab **bersamaan** dan diminta ringkas (sekitar 300 kata). Model yang tidak mulai menjawab dalam 12 detik dianggap gagal. Model yang lambat tetapi sedang menulis diberi waktu sampai 25 detik; teks yang sudah terkumpul tetap dipakai sebagai calon (ditandai terpotong).
2. Satu model penilai membaca riwayat percakapan, pesan terakhir, dan semua calon jawaban, lalu menulis satu jawaban akhir yang konsisten dengan percakapan. Jawaban akhir ini di-stream.
3. Caption menampilkan model calon dan penilainya.

Penilai default adalah model calon pertama yang berhasil dan selesai tepat waktu. Isi `LLM_JUDGE_MODEL` untuk menentukan penilai tertentu (dicoba lebih dulu). Penilai dicoba maksimal 3 model.

Perilaku jika ada yang gagal:

| Kondisi | Hasil |
|---|---|
| Hanya 1 calon yang berhasil | Jawaban calon itu dipakai langsung (tanpa penilai), caption "mode terbaik tidak lengkap" |
| Semua penilai gagal | Jawaban calon pertama dipakai apa adanya |
| Tidak ada calon yang berhasil | Jatuh ke mode berurutan dengan sisa model di daftar |
| Daftar hanya berisi 1 model | Berjalan seperti mode biasa |

Catatan: satu pesan memakai 3 panggilan calon + 1 panggilan penilai, jadi kuota gratis lebih cepat habis dan jawaban lebih lambat. Mode ini tidak memakai tool (`CHAT_TOOLS`).

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

## Dokumen

Unggah berkas agar bisa dipakai sebagai konteks chat dan dibaca lewat MCP.

- **Prasyarat:** buat store di Vercel (Storage → Create → Blob) dan hubungkan ke proyek, isi `APP_PASSWORD` (tipe Secret), lalu Redeploy. Tanpa `APP_PASSWORD`, fitur dokumen mati supaya dokumen tidak terbuka untuk umum.
- **Format:** pdf berisi teks (hasil scan/gambar tidak terbaca), txt, md, csv, tsv, json, log, xml, yaml, html. Maksimal 4 MB per berkas (batas body fungsi Vercel); teks yang disimpan maksimal 200.000 karakter. Word/Excel belum didukung.
- **Di chat:** klik **Dokumen**, unggah, lalu centang dokumen yang dipakai (maksimal 5). Isinya disisipkan sebagai konteks (total sekitar 24.000 karakter, dibagi rata; yang lebih panjang dipotong). Mode "Jawaban terbaik": para calon melihat dokumen, penilai hanya melihat percakapan dan jawaban calon.
- **Di MCP:** tool `list_documents`, `read_document` (bisa bertahap dengan `offset`), `search_documents` (pencarian kata kunci sederhana di 30 dokumen terbaru), dan `add_document`. Chat web hanya boleh membaca, tidak menulis dokumen.
- Isi dokumen diperlakukan sebagai data, bukan instruksi, tetapi model tetap bisa terpengaruh teks di dalamnya; jangan unggah dokumen dari sumber yang tidak dipercaya jika chat tool aktif.

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
