import { createHash, timingSafeEqual } from "node:crypto";
import { callTool, tools } from "../../../lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

// Server MCP minimal (Streamable HTTP, balasan JSON biasa, tanpa sesi).
// Klien menyambung ke: https://<domain-anda>/api/mcp dengan header
//   Authorization: Bearer <MCP_AUTH_TOKEN>

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "llm-mcp", version: "0.1.0" };

type RpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function rpcError(id: RpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Bandingkan hash agar panjangnya sama dan waktu perbandingannya konstan.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

async function handleRequest(msg: RpcMessage) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      };
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string") return rpcError(id, -32602, "Parameter 'name' wajib ada.");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const { text, isError } = await callTool(name, args);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } };
    }
    default:
      return rpcError(id, -32601, `Method tidak didukung: ${method}`);
  }
}

export async function POST(req: Request) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    return json({ error: "Server MCP nonaktif: MCP_AUTH_TOKEN belum diatur." }, 503);
  }
  if (!isAuthorized(req, token)) {
    return json({ error: "Tidak diizinkan." }, 401, { "WWW-Authenticate": "Bearer" });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(rpcError(null, -32700, "JSON tidak valid."), 400);
  }

  const isBatch = Array.isArray(payload);
  const messages = (isBatch ? payload : [payload]) as RpcMessage[];
  const replies: unknown[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") continue; // abaikan respons/sampah
    if (msg.id === undefined || msg.id === null) continue; // notifikasi: tidak dibalas
    replies.push(await handleRequest(msg));
  }

  if (replies.length === 0) return new Response(null, { status: 202 });
  return json(isBatch ? replies : replies[0]);
}

// Tidak ada stream server->klien dan tidak ada sesi yang bisa dihentikan.
function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
