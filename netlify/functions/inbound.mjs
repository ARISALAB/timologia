// Λήψη τιμολογίων με email.
// Το Resend παραλαμβάνει τα email του inbox.arakronservices.gr και στέλνει εδώ το συμβάν "email.received".
// Κατεβάζουμε τα συνημμένα (PDF/εικόνες) και τα φυλάμε στο Netlify Blobs, ανά επιχείρηση (κωδικός = ό,τι είναι πριν το @).
// Η ανάγνωση γίνεται αργότερα, όταν ο χρήστης ανοίξει την εφαρμογή.
// Env vars στο Netlify: RESEND_API_KEY, INBOUND_SECRET, (προαιρετικά) INBOX_DOMAIN (default inbox.arakronservices.gr)
import { getStore } from "@netlify/blobs";

const OK_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;
const OK_EXT = /\.(pdf|jpe?g|png|webp|heic|heif)$/i;
const MAX_BYTES = 8 * 1024 * 1024;

export default async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  if (!process.env.INBOUND_SECRET || url.searchParams.get("k") !== process.env.INBOUND_SECRET) return new Response("forbidden", { status: 403 });

  let ev;
  try { ev = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  if (ev?.type !== "email.received") return new Response("ignored");
  const d = ev.data || {};
  const domain = (process.env.INBOX_DOMAIN || "inbox.arakronservices.gr").toLowerCase();
  // Μόνο θυρίδες που έχουν δηλωθεί από κάποια εφαρμογή. Email σε ανύπαρκτες διευθύνσεις πετιούνται.
  const owners = getStore({ name: "inbox-owners", consistency: "strong" });
  const cand = [...new Set((d.to || []).map((a) => String(a).toLowerCase().match(/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])@([a-z0-9.-]+)/)).filter((m) => m && m[2] === domain).map((m) => m[1]))];
  const tokens = [];
  for (const t of cand) if (await owners.get(t)) tokens.push(t);
  if (!tokens.length || !d.email_id) return new Response("no recipient");

  const key = process.env.RESEND_API_KEY;
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id)}/attachments`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return new Response("attachments " + res.status, { status: 502 }); // το Resend θα ξαναπροσπαθήσει
  const list = (await res.json())?.data || [];

  const store = getStore({ name: "inbox", consistency: "strong" });
  let saved = 0;
  for (const a of list) {
    const type = a.content_type || "";
    if (!(OK_TYPES.test(type) || OK_EXT.test(a.filename || ""))) continue;
    if (a.size && a.size > MAX_BYTES) continue;
    const r = await fetch(a.download_url);
    if (!r.ok) continue;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) continue;
    const meta = { filename: (a.filename || "timologio").slice(0, 120), contentType: type || (/\.pdf$/i.test(a.filename || "") ? "application/pdf" : "image/jpeg"), from: String(d.from || "").slice(0, 160), subject: String(d.subject || "").slice(0, 200), receivedAt: new Date().toISOString() };
    for (const t of tokens) { await store.set(`${t}/${Date.now()}-${a.id}`, buf, { metadata: meta }); saved++; }
  }
  return Response.json({ saved });
};

export const config = { path: "/api/inbound" };
