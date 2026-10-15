// Η "θυρίδα" κάθε επιχείρησης: τα τιμολόγια που ήρθαν με email και δεν έχουν διαβαστεί ακόμα.
//
// Η διεύθυνση (π.χ. plakimeze@inbox.arakronservices.gr) είναι δημόσια: με αυτή μπορεί κανείς μόνο να ΣΤΕΙΛΕΙ.
// Για να ΔΙΑΒΑΣΕΙ τη θυρίδα χρειάζεται το κρυφό κλειδί, που υπάρχει μόνο μέσα στην εφαρμογή του μαγαζιού
// και στέλνεται στο header "X-Inbox-Key". Ο server κρατάει μόνο το αποτύπωμά του (SHA-256), όχι το ίδιο το κλειδί.
//
//   POST   /api/inbox?action=check     { name }              → { available }
//   POST   /api/inbox?action=register  { name, key }         → δηλώνει τη θυρίδα (ή επιβεβαιώνει ότι είναι ήδη δική σου)
//   POST   /api/inbox?action=rename    { name, to, key }     → νέο όνομα, τα τιμολόγια που περιμένουν μεταφέρονται
//   GET    /api/inbox?t=ΟΝΟΜΑ                 + X-Inbox-Key → λίστα [{ key, filename, contentType, from, subject, receivedAt }]
//   GET    /api/inbox?t=ΟΝΟΜΑ&key=...         + X-Inbox-Key → το αρχείο
//   DELETE /api/inbox?t=ΟΝΟΜΑ&key=...         + X-Inbox-Key → διαγραφή (αφού διαβαστεί)
import { getStore } from "@netlify/blobs";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED = new Set(["admin", "administrator", "info", "postmaster", "abuse", "noreply", "no-reply", "support", "test", "inbox", "mail", "root", "webmaster", "hostmaster", "security", "billing", "pricearmor", "akron", "arakron"]);
const KEY_RE = /^[A-Za-z0-9_-]{32,100}$/;

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const owners = () => getStore({ name: "inbox-owners", consistency: "strong" });
const files = () => getStore({ name: "inbox", consistency: "strong" });
const err = (msg, status) => Response.json({ error: msg }, { status });
const validName = (n) => NAME_RE.test(n) && n.length >= 3 && !RESERVED.has(n) && !n.includes("--");

// Επιστρέφει true αν το κλειδί ανοίγει αυτή τη θυρίδα
async function owns(name, key) {
  if (!KEY_RE.test(key || "")) return false;
  const o = await owners().get(name, { type: "json" });
  return !!o && o.hash === (await sha256(key));
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (req.method === "POST" && action) {
    let b; try { b = await req.json(); } catch { return err("Μη έγκυρο αίτημα.", 400); }
    const name = String(b.name || "").toLowerCase().trim();
    if (!validName(name)) return err("Το όνομα πρέπει να έχει 3–40 λατινικά γράμματα ή αριθμούς.", 400);
    const st = owners();

    if (action === "check") {
      return Response.json({ available: !(await st.get(name)) });
    }
    if (!KEY_RE.test(b.key || "")) return err("Μη έγκυρο κλειδί.", 400);
    const hash = await sha256(b.key);

    if (action === "register") {
      const cur = await st.get(name, { type: "json" });
      if (cur && cur.hash !== hash) return err("Το όνομα χρησιμοποιείται ήδη.", 409);
      if (!cur) await st.setJSON(name, { hash, createdAt: new Date().toISOString() });
      return Response.json({ ok: true, name });
    }

    if (action === "rename") {
      const to = String(b.to || "").toLowerCase().trim();
      if (!validName(to)) return err("Το νέο όνομα πρέπει να έχει 3–40 λατινικά γράμματα ή αριθμούς.", 400);
      if (!(await owns(name, b.key))) return err("Δεν έχεις πρόσβαση σε αυτή τη θυρίδα.", 403);
      if (to !== name) {
        if (await st.get(to)) return err("Το όνομα χρησιμοποιείται ήδη.", 409);
        await st.setJSON(to, { hash, createdAt: new Date().toISOString() });
        // Τα τιμολόγια που περιμένουν περνάνε στο νέο όνομα
        const fs = files();
        const { blobs } = await fs.list({ prefix: name + "/" });
        for (const x of blobs) {
          const r = await fs.getWithMetadata(x.key, { type: "arrayBuffer" });
          if (r) await fs.set(to + x.key.slice(name.length), r.data, { metadata: r.metadata });
          await fs.delete(x.key);
        }
        await st.delete(name);
      }
      return Response.json({ ok: true, name: to });
    }
    return err("Άγνωστη ενέργεια.", 400);
  }

  // Ανάγνωση θυρίδας: μόνο με το κλειδί
  const t = (url.searchParams.get("t") || "").toLowerCase();
  if (!validName(t)) return err("Μη έγκυρη θυρίδα.", 400);
  if (!(await owns(t, req.headers.get("x-inbox-key")))) return err("Δεν έχεις πρόσβαση σε αυτή τη θυρίδα.", 403);
  const key = url.searchParams.get("key");
  if (key && !key.startsWith(t + "/")) return err("Μη έγκυρο αρχείο.", 403);
  const fs = files();

  if (req.method === "DELETE") { if (key) await fs.delete(key); return Response.json({ ok: true }); }

  if (key) {
    const r = await fs.getWithMetadata(key, { type: "arrayBuffer" });
    if (!r) return err("Δεν βρέθηκε.", 404);
    return new Response(r.data, { headers: { "Content-Type": r.metadata?.contentType || "application/octet-stream", "Cache-Control": "no-store" } });
  }

  const { blobs } = await fs.list({ prefix: t + "/" });
  const items = [];
  for (const x of blobs.slice(0, 100)) {
    const m = await fs.getMetadata(x.key);
    if (m) items.push({ key: x.key, ...(m.metadata || {}) });
  }
  items.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/inbox" };
