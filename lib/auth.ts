import { createHmac, timingSafeEqual } from "node:crypto";

// Akses dilindungi kata sandi tunggal (APP_PASSWORD). Setelah login, browser menerima cookie
// httpOnly berisi HMAC dari kata sandi, jadi kata sandi itu sendiri tidak disimpan di browser.
export const COOKIE = "llm_session";

export function passwordConfigured(): boolean {
  return !!process.env.APP_PASSWORD;
}

function sign(): string {
  return createHmac("sha256", process.env.APP_PASSWORD ?? "").update("llm-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(input: string): boolean {
  if (!passwordConfigured()) return false;
  return safeEqual(createHmac("sha256", "cmp").update(input).digest("hex"), createHmac("sha256", "cmp").update(process.env.APP_PASSWORD!).digest("hex"));
}

export function sessionCookie(): string {
  return `${COOKIE}=${sign()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isAuthed(req: Request): boolean {
  if (!passwordConfigured()) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([0-9a-f]+)`));
  return !!m && safeEqual(m[1], sign());
}

/** Dokumen selalu butuh login. Chat butuh login hanya jika APP_PASSWORD diisi. */
export function docsGate(req: Request): Response | null {
  if (!passwordConfigured()) {
    return Response.json({ error: "APP_PASSWORD belum diisi di environment variables, fitur dokumen nonaktif." }, { status: 503 });
  }
  if (!isAuthed(req)) return Response.json({ error: "Perlu login." }, { status: 401 });
  return null;
}

export function chatGate(req: Request): Response | null {
  if (passwordConfigured() && !isAuthed(req)) return Response.json({ error: "Perlu login." }, { status: 401 });
  return null;
}
