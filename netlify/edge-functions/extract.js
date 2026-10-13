// Ανάγνωση τιμολογίου με Gemini.
// POST /api/extract  body: { files: [{ mimeType, data(base64) }], ownAfm?: "123456789" }
// Απαιτεί env var GEMINI_API_KEY στο Netlify. Προαιρετικά GEMINI_MODEL (default gemini-3.8-flash).

const S = (type) => ({ type, nullable: true });

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
        },
      },
    },
    notes: S("STRING"),
  },
  required: ["supplier", "invoice", "lines"],
};

function buildPrompt(ownAfm) {
  return `Είσαι σύστημα εξαγωγής δεδομένων από ελληνικά παραστατικά αγορών (τιμολόγια, δελτία αποστολής-τιμολόγια, αποδείξεις) επιχειρήσεων εστίασης.
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
- Μην επινοείς τιμές ή κωδικούς. Αν κάτι δεν φαίνεται ή δεν διαβάζεται, βάλε null.
- Αν υπάρχουν χειρόγραφες διορθώσεις τιμών ή ποσοτήτων, κράτα τις τυπωμένες τιμές και ανέφερε τη διόρθωση στο notes.
- Αν οι εικόνες είναι πολλές σελίδες του ίδιου παραστατικού, συνδύασέ τες σε ένα αποτέλεσμα.`;
}

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "Λείπει το GEMINI_API_KEY στις ρυθμίσεις του Netlify (Environment variables)." }, 500);
  const model = Netlify.env.get("GEMINI_MODEL") || "gemini-3.8-flash";

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Μη έγκυρο αίτημα." }, 400);
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return json({ error: "Δεν στάλθηκε αρχείο." }, 400);
  if (files.length > 6) return json({ error: "Έως 6 σελίδες ανά τιμολόγιο." }, 400);

  const ownAfm = /^\d{9}$/.test(String(body.ownAfm || "")) ? String(body.ownAfm) : "";
  const parts = [{ text: buildPrompt(ownAfm) }];
  for (const f of files) {
    if (!f || !ALLOWED.includes(f.mimeType) || typeof f.data !== "string" || !f.data.length) {
      return json({ error: "Μη υποστηριζόμενος τύπος αρχείου. Δεκτά: JPG, PNG, WEBP, PDF." }, 400);
    }
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  }

  const generationConfig = {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: SCHEMA,
  };
  // Στα μοντέλα 2.5 κλείνουμε το "thinking" για ταχύτητα και χαμηλότερο κόστος.
  if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let res, data;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
      }
    );
    data = await res.json().catch(() => null);
  } catch (e) {
    return json({ error: "Δεν ήταν δυνατή η σύνδεση με το Gemini." }, 502);
  }

  if (!res.ok) {
    if (res.status === 429) {
      return json({ error: "Έφτασες το όριο του δωρεάν Gemini. Δοκίμασε ξανά σε ένα λεπτό." }, 429);
    }
    return json({ error: data?.error?.message || `Σφάλμα Gemini (${res.status})` }, 502);
  }

  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return json({ error: "Το Gemini δεν επέστρεψε έγκυρα δεδομένα. Δοκίμασε πιο καθαρή φωτογραφία." }, 502);
  }

  return json({ result, model, usage: data?.usageMetadata || null });
};

export const config = { path: "/api/extract" };
