// Ανάγνωση τιμολογίου με Gemini.
// POST /api/extract  body: { files: [{ mimeType, data(base64) }], ownAfm?, categories?: [..], businessType? }
// POST /api/extract  body: { mode: "classify", items: ["περιγραφή", ...], categories?: [..], businessType? }
// Απαιτεί env var GEMINI_API_KEY στο Netlify. Προαιρετικά GEMINI_MODEL (default gemini-3.8-flash).

const S = (type) => ({ type, nullable: true });

const clean = (s, n = 60) => String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);

// Οδηγίες κατηγοριοποίησης: οι κατηγορίες είναι της κάθε επιχείρησης, δεν υπάρχει έτοιμη λίστα.
function categoryRules(categories, businessType) {
  const list = categories.length ? categories.map((c) => `"${c}"`).join(", ") : "(καμία ακόμα)";
  return `Κατηγορίες ειδών της επιχείρησης${businessType ? ` (είδος επιχείρησης: ${businessType})` : ""}: ${list}.
- Βάλε κάθε είδος σε μία από τις υπάρχουσες κατηγορίες, γραμμένη ΑΚΡΙΒΩΣ όπως παραπάνω, αν ταιριάζει λογικά.
- Αν δεν ταιριάζει καμία, δημιούργησε νέα κατηγορία: σύντομη (1–3 λέξεις), στα ελληνικά, γενική και χρήσιμη για αυτό το είδος επιχείρησης (π.χ. για εστιατόριο "Γαλακτοκομικά", για κομμωτήριο "Βαφές μαλλιών").
- Προτίμησε λίγες, γενικές κατηγορίες αντί για πολλές μικρές. Μην φτιάχνεις κατηγορία για ένα μόνο προϊόν αν χωράει σε γενικότερη.`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    supplier: {
      type: "OBJECT",
      properties: {
        name: S("STRING"),
        afm: S("STRING"),
        doy: S("STRING"),
        address: S("STRING"),
        phone: S("STRING"),
        email: S("STRING"),
      },
    },
    invoice: {
      type: "OBJECT",
      properties: {
        number: S("STRING"),
        date: S("STRING"),
        type: S("STRING"),
        mark: S("STRING"),
        net_total: S("NUMBER"),
        vat_total: S("NUMBER"),
        total: S("NUMBER"),
        payment_method: S("STRING"),
        due_date: S("STRING"),
      },
    },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: S("STRING"),
          description: S("STRING"),
          quantity: S("NUMBER"),
          unit: S("STRING"),
          unit_price: S("NUMBER"),
          discount_pct: S("NUMBER"),
          net_amount: S("NUMBER"),
          vat_pct: S("NUMBER"),
          category: S("STRING"),
        },
      },
    },
    notes: S("STRING"),
  },
  required: ["supplier", "invoice", "lines"],
};

function buildPrompt(ownAfm, categories, businessType) {
  return `Είσαι σύστημα εξαγωγής δεδομένων από ελληνικά παραστατικά αγορών (τιμολόγια, δελτία αποστολής-τιμολόγια, αποδείξεις) επιχειρήσεων.
Επέστρεψε ΜΟΝΟ JSON σύμφωνα με το schema.

Κανόνες:
- supplier = ο ΕΚΔΟΤΗΣ του παραστατικού (πωλητής), συνήθως στην κεφαλίδα με το λογότυπο. ΟΧΙ ο πελάτης/αγοραστής (πεδία "Πελάτης", "Στοιχεία πελάτη", "Παραλήπτης", "Αγοραστής").
${ownAfm ? `- Ο αγοραστής έχει ΑΦΜ ${ownAfm}. Αυτό το ΑΦΜ ΔΕΝ είναι ποτέ του προμηθευτή.\n` : ""}- afm: μόνο τα 9 ψηφία, χωρίς "EL", κενά ή τελείες.
- Αριθμοί: στα ελληνικά τιμολόγια το κόμμα είναι δεκαδικό και η τελεία χιλιάδες (1.234,56 = 1234.56). Επέστρεψε καθαρούς αριθμούς JSON.
- Ημερομηνίες σε μορφή YYYY-MM-DD (π.χ. 05/03/2026 → 2026-03-05).
- invoice.number: ο αριθμός παραστατικού μαζί με τη σειρά αν υπάρχει (π.χ. "Α 1234"). invoice.type: το είδος παραστατικού όπως είναι τυπωμένο.
- invoice.mark: ο ΜΑΡΚ myDATA αν είναι τυπωμένος (μακρύς αριθμός δίπλα στη λέξη ΜΑΡΚ), αλλιώς null.
- net_total = σύνολο καθαρής αξίας χωρίς ΦΠΑ, vat_total = σύνολο ΦΠΑ, total = πληρωτέο σύνολο.
- lines: μία εγγραφή για κάθε γραμμή είδους. code = κωδικός είδους όπως είναι τυπωμένος (null αν δεν υπάρχει). description = περιγραφή όπως γράφεται. unit = μονάδα μέτρησης (ΚΙΛ, ΤΕΜ, ΛΙΤ, ΚΙΒ κ.λπ.). unit_price = τιμή μονάδας ΧΩΡΙΣ ΦΠΑ. discount_pct = έκπτωση %. net_amount = καθαρή αξία γραμμής χωρίς ΦΠΑ. vat_pct = συντελεστής ΦΠΑ (π.χ. 13 ή 24).
- category: η κατηγορία του είδους, σύμφωνα με τους κανόνες κατηγοριών παρακάτω.
- Μην επινοείς τιμές ή κωδικούς. Αν κάτι δεν φαίνεται ή δεν διαβάζεται, βάλε null.
- Αν υπάρχουν χειρόγραφες διορθώσεις τιμών ή ποσοτήτων, κράτα τις τυπωμένες τιμές και ανέφερε τη διόρθωση στο notes.
- Αν οι εικόνες είναι πολλές σελίδες του ίδιου παραστατικού, συνδύασέ τες σε ένα αποτέλεσμα.

${categoryRules(categories, businessType)}`;
}

const CLASSIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    assignments: { type: "ARRAY", items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, category: { type: "STRING" } }, required: ["i", "category"] } },
  },
  required: ["assignments"],
};

const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.5-flash";

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const json = (obj) => obj; // το αποτέλεσμα γράφεται στο stream (βλ. κάτω)

async function work(request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "Λείπει το GEMINI_API_KEY στις ρυθμίσεις του Netlify (Environment variables)." }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Μη έγκυρο αίτημα." }, 400);
  }

  const categories = (Array.isArray(body.categories) ? body.categories : []).map((c) => clean(c, 40)).filter(Boolean).slice(0, 80);
  const businessType = clean(body.businessType, 60);
  let parts, schema;

  if (body.mode === "classify") {
    // Μόνο κείμενο: γρήγορο και φθηνό
    const items = (Array.isArray(body.items) ? body.items : []).map((x) => clean(x, 120)).slice(0, 300);
    if (!items.length) return json({ error: "Δεν στάλθηκαν είδη." }, 400);
    parts = [{ text: `Κατάταξε τα παρακάτω είδη που αγοράζει μια επιχείρηση σε κατηγορίες.
${categoryRules(categories, businessType)}
Επέστρεψε JSON: assignments = [{ i: αριθμός είδους, category }] για ΚΑΘΕ είδος.

Είδη:
${items.map((x, i) => `${i}. ${x}`).join("\n")}` }];
    schema = CLASSIFY_SCHEMA;
  } else {
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return json({ error: "Δεν στάλθηκε αρχείο." }, 400);
    if (files.length > 6) return json({ error: "Έως 6 σελίδες ανά τιμολόγιο." }, 400);
    const ownAfm = /^\d{9}$/.test(String(body.ownAfm || "")) ? String(body.ownAfm) : "";
    parts = [{ text: buildPrompt(ownAfm, categories, businessType) }];
    for (const f of files) {
      if (!f || !ALLOWED.includes(f.mimeType) || typeof f.data !== "string" || !f.data.length) {
        return json({ error: "Μη υποστηριζόμενος τύπος αρχείου. Δεκτά: JPG, PNG, WEBP, PDF." }, 400);
      }
      parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
    }
    schema = SCHEMA;
  }

  // Σειρά μοντέλων: το πρώτο είναι το κύριο, τα υπόλοιπα εφεδρικά.
  // Με GEMINI_MODEL στο Netlify (π.χ. "gemini-3.8-flash,gemini-3.5-flash") αλλάζει χωρίς αλλαγή κώδικα.
  const models = (Netlify.env.get("GEMINI_MODEL") || DEFAULT_MODELS)
    .split(",").map((m) => m.trim()).filter(Boolean);

  const started = Date.now();
  const tried = []; // π.χ. "gemini-3.8-flash: 503" — εμφανίζεται στην εφαρμογή αν αποτύχουν όλα
  let lastStatus = 0, lastMsg = "";

  for (const model of models) {
    const left = 110000 - (Date.now() - started); // συνολικό όριο 110″
    if (left < 10000) { tried.push(`${model}: δεν έμεινε χρόνος`); break; }

    let thinking = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const generationConfig = { temperature: 0, responseMimeType: "application/json", responseSchema: schema };
      // Λίγη "σκέψη" = πιο γρήγορη απάντηση. Η εξαγωγή τιμολογίου δεν χρειάζεται βαθιά συλλογιστική.
      if (thinking) {
        if (/gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
        else if (/gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
      }

      let res, data;
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.min(left - 1000, 60000));
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        data = await res.json().catch(() => null);
      } catch (e) {
        lastStatus = 504; lastMsg = "Το Gemini άργησε να απαντήσει.";
        tried.push(`${model}: timeout ${Math.round((Date.now() - t0) / 1000)}″`);
        break; // επόμενο μοντέλο
      }

      const secs = Math.round((Date.now() - t0) / 1000);
      if (res.ok) {
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        try {
          return json({ result: JSON.parse(text), model, seconds: secs, tried, usage: data?.usageMetadata || null });
        } catch {
          lastStatus = 502; lastMsg = "Το Gemini δεν επέστρεψε έγκυρα δεδομένα. Δοκίμασε πιο καθαρή φωτογραφία.";
          tried.push(`${model}: άκυρο JSON`);
          break;
        }
      }

      lastStatus = res.status;
      lastMsg = data?.error?.message || `Σφάλμα Gemini (${res.status})`;
      tried.push(`${model}: ${res.status}`);

      // Αν το μοντέλο δεν δέχεται τη ρύθμιση thinking, ξανά χωρίς αυτήν.
      if (res.status === 400 && thinking && /thinking/i.test(lastMsg)) { thinking = false; continue; }
      // Σφάλμα κλειδιού/αιτήματος (όχι μοντέλου): δεν έχει νόημα να δοκιμάσουμε άλλο μοντέλο.
      if ([400, 401, 403].includes(res.status) && !/model/i.test(lastMsg)) return json({ error: lastMsg, tried }, 502);
      // 503 υπερφόρτωση, 429 όριο, 404 μη διαθέσιμο: κατευθείαν στο επόμενο μοντέλο (πιο γρήγορο από αναμονή).
      break;
    }
  }

  if (lastStatus === 429) return json({ error: "Έφτασες το όριο του δωρεάν Gemini. Δοκίμασε ξανά σε ένα λεπτό.", tried }, 429);
  if (lastStatus === 503 || lastStatus === 500) return json({ error: "Το Gemini είναι προσωρινά υπερφορτωμένο. Δοκίμασε ξανά σε λίγο.", tried }, 503);
  return json({ error: lastMsg || "Αποτυχία ανάγνωσης.", tried }, 502);
}

// Το Netlify κόβει μια απάντηση που δεν έχει ξεκινήσει μέσα σε ~40″.
// Γι' αυτό ξεκινάμε αμέσως την απάντηση και στέλνουμε ένα κενό κάθε 5″ όσο σκέφτεται το Gemini.
// Τα κενά πριν από το JSON αγνοούνται από το res.json() του browser.
export default async (request) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(" ")); // αμέσως: η απάντηση έχει ξεκινήσει
      const ping = setInterval(() => { try { controller.enqueue(enc.encode(" ")); } catch {} }, 5000);
      let out;
      try { out = await work(request); }
      catch (e) { out = { error: "Απρόσμενο σφάλμα: " + (e?.message || e) }; }
      clearInterval(ping);
      controller.enqueue(enc.encode(JSON.stringify(out)));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
};

export const config = { path: "/api/extract" };
