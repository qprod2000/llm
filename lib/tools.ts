import { DocError, MAX_DOC_CHARS, addDoc, listDocs, readDoc, searchDocs } from "./docs";

// Definisi tool dipakai bersama oleh server MCP (/api/mcp) dan chat (/api/chat).
// Untuk menambah tool baru, cukup tambahkan satu objek ke array `tools` di bawah.

export type Tool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  run: (args: Record<string, unknown>) => Promise<string> | string;
};

class ToolError extends Error {}

// ---------- Tool 1: waktu sekarang ----------
const getCurrentTime: Tool = {
  name: "get_current_time",
  description:
    "Mengembalikan tanggal dan waktu saat ini untuk zona waktu tertentu (nama IANA, misalnya Asia/Jakarta).",
  inputSchema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "Nama zona waktu IANA. Default: Asia/Jakarta.",
      },
    },
  },
  run(args) {
    const timeZone = typeof args.timezone === "string" && args.timezone ? args.timezone : "Asia/Jakarta";
    const now = new Date();
    try {
      const readable = new Intl.DateTimeFormat("id-ID", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      return `${readable} (${timeZone}); UTC: ${now.toISOString()}`;
    } catch {
      throw new ToolError(`Zona waktu tidak valid: ${timeZone}`);
    }
  },
};

// ---------- Tool 2: kalkulator aman (tanpa eval) ----------
function evaluate(expr: string): number {
  let i = 0;
  const peek = () => expr[i];
  const skip = () => {
    while (expr[i] === " ") i++;
  };

  function parseNumber(): number {
    skip();
    const start = i;
    while (i < expr.length && /[0-9.]/.test(expr[i])) i++;
    if (start === i) throw new ToolError(`Ekspresi tidak valid di posisi ${i + 1}`);
    const n = Number(expr.slice(start, i));
    if (Number.isNaN(n)) throw new ToolError("Angka tidak valid");
    return n;
  }

  function parsePrimary(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = parseAddSub();
      skip();
      if (peek() !== ")") throw new ToolError("Kurung tutup tidak ditemukan");
      i++;
      return v;
    }
    return parseNumber();
  }

  function parseUnary(): number {
    skip();
    if (peek() === "-") {
      i++;
      return -parseUnary();
    }
    if (peek() === "+") {
      i++;
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    skip();
    if (peek() === "^") {
      i++;
      return Math.pow(base, parseUnary()); // pangkat bersifat right-associative
    }
    return base;
  }

  function parseMulDiv(): number {
    let v = parseUnary();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return v;
      i++;
      const r = parseUnary();
      if (op === "*") v *= r;
      else if (r === 0) throw new ToolError("Pembagian dengan nol");
      else v = op === "/" ? v / r : v % r;
    }
  }

  function parseAddSub(): number {
    let v = parseMulDiv();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = parseMulDiv();
      v = op === "+" ? v + r : v - r;
    }
  }

  const result = parseAddSub();
  skip();
  if (i < expr.length) throw new ToolError(`Karakter tidak dikenal di posisi ${i + 1}: "${expr[i]}"`);
  return result;
}

const calculate: Tool = {
  name: "calculate",
  description:
    "Menghitung ekspresi aritmetika. Mendukung + - * / % ^ dan tanda kurung, misalnya (12.5 + 3) * 4 ^ 2.",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Ekspresi yang dihitung, maksimal 200 karakter." },
    },
    required: ["expression"],
  },
  run(args) {
    const expression = args.expression;
    if (typeof expression !== "string" || !expression.trim()) {
      throw new ToolError("Parameter 'expression' wajib berupa teks.");
    }
    if (expression.length > 200) throw new ToolError("Ekspresi terlalu panjang.");
    const value = evaluate(expression);
    if (!Number.isFinite(value)) throw new ToolError("Hasil tidak terdefinisi atau terlalu besar.");
    return String(value);
  },
};

// ---------- Tool dokumen (butuh Vercel Blob) ----------
const listDocuments: Tool = {
  name: "list_documents",
  description: "Menampilkan daftar dokumen yang tersimpan (id, nama, ukuran, tanggal unggah).",
  inputSchema: { type: "object", properties: {} },
  async run() {
    const docs = await listDocs();
    if (!docs.length) return "Belum ada dokumen tersimpan.";
    return docs.map((d) => `- [${d.id}] ${d.name} (${d.size} byte, ${d.uploadedAt})`).join("\n");
  },
};

const readDocument: Tool = {
  name: "read_document",
  description: "Membaca isi teks satu dokumen berdasarkan id. Untuk dokumen panjang, pakai offset untuk bagian berikutnya.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "ID dokumen dari list_documents." },
      offset: { type: "number", description: "Mulai dari karakter ke-berapa (default 0)." },
      length: { type: "number", description: "Jumlah karakter (default 20000, maksimal 50000)." },
    },
    required: ["id"],
  },
  async run(args) {
    if (typeof args.id !== "string") throw new ToolError("Parameter 'id' wajib berupa teks.");
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const length = Math.min(50_000, Math.max(1, Math.floor(Number(args.length) || 20_000)));
    const { meta, text } = await readDoc(args.id);
    const part = text.slice(offset, offset + length);
    const end = offset + part.length;
    const more = end < text.length ? ` Masih ada lanjutan: panggil lagi dengan offset=${end}.` : "";
    return `Dokumen: ${meta.name} (karakter ${offset}-${end} dari ${text.length}).${more}\n\n${part}`;
  },
};

const searchDocuments: Tool = {
  name: "search_documents",
  description: "Mencari kata kunci di semua dokumen tersimpan; mengembalikan dokumen yang cocok beserta cuplikannya.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Kata kunci, dipisah spasi." } },
    required: ["query"],
  },
  async run(args) {
    if (typeof args.query !== "string") throw new ToolError("Parameter 'query' wajib berupa teks.");
    return searchDocs(args.query);
  },
};

const addDocument: Tool = {
  name: "add_document",
  description: `Menyimpan teks sebagai dokumen baru (maksimal ${MAX_DOC_CHARS} karakter).`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nama dokumen, misalnya catatan.md." },
      content: { type: "string", description: "Isi teks dokumen." },
    },
    required: ["name", "content"],
  },
  async run(args) {
    if (typeof args.name !== "string" || typeof args.content !== "string") {
      throw new ToolError("Parameter 'name' dan 'content' wajib berupa teks.");
    }
    const { meta, truncated } = await addDoc(args.name, args.content);
    return `Tersimpan: [${meta.id}] ${meta.name}${truncated ? " (dipotong karena terlalu panjang)" : ""}`;
  },
};

export const tools: Tool[] = [getCurrentTime, calculate, listDocuments, readDocument, searchDocuments, addDocument];

// Tool untuk chat web: dokumen hanya tersedia bila APP_PASSWORD diisi (supaya pengunjung anonim
// tidak bisa membaca dokumen), dan chat hanya boleh membaca, tidak menulis dokumen.
export function chatTools(): Tool[] {
  const docsOk = !!process.env.APP_PASSWORD;
  const docTools = ["list_documents", "read_document", "search_documents"];
  return tools.filter((t) => (t.name === "add_document" ? false : docTools.includes(t.name) ? docsOk : true));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  available: Tool[] = tools,
): Promise<{ text: string; isError: boolean }> {
  const tool = available.find((t) => t.name === name);
  if (!tool) return { text: `Tool tidak dikenal: ${name}`, isError: true };
  try {
    return { text: await tool.run(args ?? {}), isError: false };
  } catch (err) {
    // Hanya pesan dari ToolError yang diteruskan apa adanya; error lain disamarkan.
    const text = err instanceof ToolError || err instanceof DocError ? err.message : "Terjadi kesalahan saat menjalankan tool.";
    return { text, isError: true };
  }
}
