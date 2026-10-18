import { docsGate } from "../../../lib/auth";
import { DocError, MAX_UPLOAD_BYTES, addDoc, deleteDoc, extractText, listDocs } from "../../../lib/docs";

export const runtime = "nodejs";
export const maxDuration = 60;

function fail(err: unknown) {
  if (err instanceof DocError) return Response.json({ error: err.message }, { status: 400 });
  console.error("docs error", err);
  return Response.json({ error: "Terjadi kesalahan pada penyimpanan dokumen." }, { status: 500 });
}

export async function GET(req: Request) {
  const blocked = docsGate(req);
  if (blocked) return blocked;
  try {
    return Response.json({ docs: await listDocs() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  const blocked = docsGate(req);
  if (blocked) return blocked;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new DocError("Pilih berkas untuk diunggah.");
    if (file.size > MAX_UPLOAD_BYTES) throw new DocError("Berkas terlalu besar (maksimal 4 MB).");
    const text = await extractText(file.name, await file.arrayBuffer());
    const { meta, truncated } = await addDoc(file.name, text);
    return Response.json({ doc: meta, truncated });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const blocked = docsGate(req);
  if (blocked) return blocked;
  try {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    await deleteDoc(id);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
