import { checkPassword, clearCookie, isAuthed, passwordConfigured, sessionCookie } from "../../../lib/auth";

export const runtime = "nodejs";

// GET: status login. POST: {password} -> set cookie. DELETE: logout.
export async function GET(req: Request) {
  return Response.json({ required: passwordConfigured(), authed: !passwordConfigured() ? true : isAuthed(req) });
}

export async function POST(req: Request) {
  if (!passwordConfigured()) return Response.json({ error: "APP_PASSWORD belum diisi." }, { status: 503 });
  let password = "";
  try {
    password = String(((await req.json()) as { password?: unknown }).password ?? "");
  } catch {}
  // jeda kecil agar tebak-tebakan kata sandi lebih lambat
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(password)) return Response.json({ error: "Kata sandi salah." }, { status: 401 });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie() },
  });
}

export async function DELETE() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": clearCookie() },
  });
}
