// Η "θυρίδα" κάθε επιχείρησης: τα τιμολόγια που ήρθαν με email και δεν έχουν διαβαστεί ακόμα.
//   GET    /api/inbox?t=ΚΩΔΙΚΟΣ            → λίστα [{ key, filename, contentType, from, subject, receivedAt }]
//   GET    /api/inbox?t=ΚΩΔΙΚΟΣ&key=...    → το αρχείο
//   DELETE /api/inbox?t=ΚΩΔΙΚΟΣ&key=...    → διαγραφή (αφού διαβαστεί)
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const t = (url.searchParams.get("t") || "").toLowerCase();
  if (!/^[a-z0-9]{10,40}$/.test(t)) return Response.json({ error: "Μη έγκυρος κωδικός." }, { status: 400 });
  const key = url.searchParams.get("key");
  if (key && !key.startsWith(t + "/")) return Response.json({ error: "Μη έγκυρο αρχείο." }, { status: 403 });
  const store = getStore({ name: "inbox", consistency: "strong" });

  if (req.method === "DELETE") { if (key) await store.delete(key); return Response.json({ ok: true }); }

  if (key) {
    const r = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!r) return Response.json({ error: "Δεν βρέθηκε." }, { status: 404 });
    return new Response(r.data, { headers: { "Content-Type": r.metadata?.contentType || "application/octet-stream", "Cache-Control": "no-store" } });
  }

  const { blobs } = await store.list({ prefix: t + "/" });
  const items = [];
  for (const b of blobs.slice(0, 100)) {
    const m = await store.getMetadata(b.key);
    if (m) items.push({ key: b.key, ...(m.metadata || {}) });
  }
  items.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/inbox" };
