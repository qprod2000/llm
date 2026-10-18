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

export const tools: Tool[] = [getCurrentTime, calculate];

export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `Tool tidak dikenal: ${name}`, isError: true };
  try {
    return { text: await tool.run(args ?? {}), isError: false };
  } catch (err) {
    // Hanya pesan dari ToolError yang diteruskan apa adanya; error lain disamarkan.
    const text = err instanceof ToolError ? err.message : "Terjadi kesalahan saat menjalankan tool.";
    return { text, isError: true };
  }
}
