// Ανάγνωση τιμολογίου με Gemini.
// POST /api/extract  body: { files: [{ mimeType, data(base64) }], ownAfm?, categories?: [..], businessType? }
// POST /api/extract  body: { mode: "classify", items: ["περιγραφή", ...], categories?: [..], businessType? }
// Απαιτεί env var GEMINI_API_KEY στο Netlify. Προαιρετικά GEMINI_MODEL (default gemini-3.8-flash).

const S = (type) => ({ type, nullable: true });

const clean = (s, n = 60) => String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);

// Λέξεις από πεδία/κεφαλίδες τιμολογίου ή λογιστικοί όροι: ΠΟΤΕ κατηγορία προϊόντος.
const strip = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const BAD_CAT = /^(φορολογικ|εδρα|δ\.?ο\.?υ|α\.?φ\.?μ|διευθυνσ|πελατ|αγοραστ|προμηθευτ|εκδοτ|συνολ|φ\.?π\.?α|λειτουργικ|εξοδα|διαφορ|λοιπ|γενικ|τιμολογ|παραστατικ|αποδειξ|πληρωμ|υπολοιπ|σειρα|αριθμ|ημερομην|μαρκ|τηλεφων|email|null|none|-)/;
const badCat = (c) => !strip(c) || BAD_CAT.test(strip(c));

// Οδηγίες κατηγοριοποίησης: οι κατηγορίες είναι της κάθε επιχείρησης, δεν υπάρχει έτοιμη λίστα.
function categoryRules(categories, businessType) {
  const list = categories.length ? categories.map((c) => `"${c}"`).join(", ") : "(καμία ακόμα)";
  return `Κατηγορίες ειδών της επιχείρησης${businessType ? ` (είδος επιχείρησης: ${businessType})` : ""}: ${list}.
- Βάλε κάθε είδος σε μία από τις υπάρχουσες κατηγορίες, γραμμένη ΑΚΡΙΒΩΣ όπως παραπάνω, αν ταιριάζει λογικά.
- Αν δεν ταιριάζει καμία, δημιούργησε νέα κατηγορία: σύντομη (1–3 λέξεις), στα ελληνικά, γενική και χρήσιμη για αυτό το είδος επιχείρησης (π.χ. για εστιατόριο "Γαλακτοκομικά", για κομμωτήριο "Βαφές μαλλιών").
- Η κατηγορία περιγράφει το ΙΔΙΟ ΤΟ ΠΡΟΪΟΝ (π.χ. ντομάτες, πατάτες → "Λαχανικά", λεμόνια → "Φρούτα", ελιές → "Τρόφιμα παντοπωλείου"). ΠΟΤΕ λέξεις από την κεφαλίδα ή τα πεδία του παραστατικού ("Φορολογική έδρα", "ΔΟΥ", "Διεύθυνση", "Πελάτης", "Σύνολο" κ.λπ.). Αν κάποια υπάρχουσα κατηγορία δεν περιγράφει είδος προϊόντος, αγνόησέ την.
- Είδη διαφορετικού τύπου δεν μπαίνουν στην ίδια κατηγορία μόνο επειδή είναι στο ίδιο τιμολόγιο.
- Η κατηγορία λέει ΤΙ ΕΙΝΑΙ το είδος (π.χ. "Τηλεπικοινωνίες", "Διακόσμηση", "Μεταφορικά & αποστολές", "Γαλακτοκομικά"). ΠΟΤΕ λογιστικές ή γενικές κατηγορίες όπως "Λειτουργικά έξοδα", "Έξοδα", "Διάφορα", "Λοιπά", "Γενικά", ακόμα κι αν υπάρχουν στη λίστα.
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
    buyer: {
      type: "OBJECT",
      properties: { name: S("STRING"), afm: S("STRING") },
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
${ownAfm ? `- Ο αγοραστής έχει ΑΦΜ ${ownAfm}. Αυτό το ΑΦΜ ΔΕΝ είναι ποτέ του προμηθευτή.\n` : ""}- buyer = ο ΠΕΛΑΤΗΣ/αγοραστής στον οποίο εκδόθηκε το παραστατικό ("Στοιχεία πελάτη", "Πελάτης", "Αγοραστής"): επωνυμία και ΑΦΜ όπως είναι τυπωμένα. Αν δεν αναγράφεται αγοραστής (π.χ. απόδειξη λιανικής), null.
- afm: μόνο τα 9 ψηφία, χωρίς "EL", κενά ή τελείες.
- Αριθμοί: στα ελληνικά τιμολόγια το κόμμα είναι δεκαδικό και η τελεία χιλιάδες (1.234,56 = 1234.56). Επέστρεψε καθαρούς αριθμούς JSON.
- Ημερομηνίες σε μορφή YYYY-MM-DD (π.χ. 05/03/2026 → 2026-03-05).
- invoice.number: ο αριθμός παραστατικού μαζί με τη σειρά αν υπάρχει (π.χ. "Α 1234"). invoice.type: το είδος παραστατικού όπως είναι τυπωμένο.
- invoice.mark: ο ΜΑΡΚ myDATA = ΜΟΝΟ ψηφία (συνήθως 15), συχνά κοντά στο QR code ή δίπλα στη λέξη ΜΑΡΚ. Οι μακριοί κωδικοί με γράμματα και αριθμούς (π.χ. 589C92A4...) ΔΕΝ είναι ΜΑΡΚ. Αν δεν υπάρχει, null.
- net_total = σύνολο καθαρής αξίας χωρίς ΦΠΑ, vat_total = σύνολο ΦΠΑ, total = συνολική αξία ΑΥΤΟΥ του παραστατικού με ΦΠΑ (μπορεί να γράφεται "Σύνολο", "Γενικό σύνολο", "Πληρωτέο", "Ποσό πληρωμής", "Συνολικό ποσό"). Αν υπάρχει προηγούμενο υπόλοιπο ή οφειλή από παλαιότερο λογαριασμό, ΜΗΝ το προσθέτεις στο total.
- Τα net_total, vat_total και total ΠΡΕΠΕΙ να συμπληρώνονται. Αν φαίνονται μόνο δύο από τα τρία, υπολόγισε το τρίτο (total = net_total + vat_total).
- Λογαριασμοί υπηρεσιών (τηλεφωνία, internet, ρεύμα, νερό, φυσικό αέριο, ενοίκια, συνδρομές, ασφάλιστρα): επέστρεψε ΜΙΑ γραμμή για ΟΛΟ τον λογαριασμό, με description την υπηρεσία και τον πάροχο (π.χ. "Τηλεπικοινωνιακές υπηρεσίες Nova"), quantity 1 και unit_price = net_amount = net_total. Τέλη, πάγια, επιμέρους χρεώσεις και εκπτώσεις του ίδιου λογαριασμού ΔΕΝ γίνονται ξεχωριστές γραμμές.
- supplier.address: μόνο οδός, αριθμός, ΤΚ, πόλη. ΟΧΙ τηλέφωνα, fax, ΑΦΜ, ΓΕΜΗ ή άλλα στοιχεία.
- Αν η ημερομηνία έκδοσης δεν φαίνεται, βάλε null (όχι τη σημερινή).
- lines: μία εγγραφή για κάθε γραμμή είδους. code = κωδικός είδους όπως είναι τυπωμένος (null αν δεν υπάρχει). description = περιγραφή όπως γράφεται. unit = μονάδα μέτρησης (ΚΙΛ, ΤΕΜ, ΛΙΤ, ΚΙΒ κ.λπ.). unit_price = τιμή μονάδας ΧΩΡΙΣ ΦΠΑ. discount_pct = έκπτωση %. net_amount = καθαρή αξία γραμμής χωρίς ΦΠΑ. vat_pct = συντελεστής ΦΠΑ (π.χ. 13 ή 24).
- category: η κατηγορία του είδους, σύμφωνα με τους κανόνες κατηγοριών παρακάτω.
- unit_price: αν δεν είναι τυπωμένη τιμή μονάδας, υπολόγισέ την ως net_amount / quantity. Ποτέ 0 όταν η γραμμή έχει αξία.
- Αν η τιμή μονάδας είναι τυπωμένη ΜΕ ΦΠΑ, γράψε την τιμή ΧΩΡΙΣ ΦΠΑ. Έλεγχος: quantity × unit_price × (1 − discount_pct/100) = net_amount.
- Μην επινοείς τιμές ή κωδικούς. Αν κάτι δεν φαίνεται ή δεν διαβάζεται, βάλε null.
- Αν υπάρχουν χειρόγραφες διορθώσεις τιμών ή ποσοτήτων, κράτα τις τυπωμένες τιμές και ανέφερε τη διόρθωση στο notes.
- Αν οι εικόνες είναι πολλές σελίδες του ίδιου παραστατικού, συνδύασέ τες σε ένα αποτέλεσμα.

${categoryRules(categories, businessType)}`;
}

// Το Gemini δεν ακολουθεί πάντα τα ονόματα πεδίων του schema (π.χ. "issue_date" αντί "date", "items" αντί "lines").
// Εδώ μεταφράζουμε όλα τα συνηθισμένα ονόματα στα δικά μας, ώστε να μη χάνονται στοιχεία που διαβάστηκαν σωστά.
const pick = (o, keys) => { if (!o || typeof o !== "object") return undefined; for (const k of keys) { const v = o[k]; if (v != null && v !== "") return v; } return undefined; };
function toNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let t = v.replace(/[€%\s]/g, "").replace(/[^\d.,\-]/g, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (t.includes(",")) t = t.replace(",", ".");
  const n = parseFloat(t); return isFinite(n) ? n : null;
}
function toDate(v) {
  if (typeof v !== "string") return v == null ? null : String(v);
  const s = v.trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return s || null;
}
const K = {
  name: ["name", "company_name", "legal_name", "business_name", "title", "company", "eponymia"],
  afm: ["afm", "vat_number", "vat_id", "tax_id", "taxId", "vatNumber", "tin", "vat"],
  doy: ["doy", "tax_office", "taxOffice"], address: ["address", "full_address", "street"], phone: ["phone", "telephone", "tel", "phone_number"], email: ["email", "e_mail", "mail"],
  number: ["number", "invoice_number", "document_number", "invoiceNumber", "doc_number", "no", "series_number", "account_number"],
  date: ["date", "issue_date", "invoice_date", "date_of_issue", "issueDate", "invoiceDate", "document_date"],
  type: ["type", "document_type", "invoice_type", "doc_type"], mark: ["mark", "MARK", "mydata_mark", "mark_number"],
  net: ["net_total", "net_amount", "total_net", "subtotal", "net", "netTotal", "total_net_amount", "net_value"],
  vat: ["vat_total", "vat_amount", "total_vat", "vatTotal", "tax_amount", "vat"],
  total: ["total", "total_amount", "grand_total", "amount_due", "payable", "payable_amount", "gross_total", "totalAmount", "total_with_vat", "gross_amount"],
  pay: ["payment_method", "paymentMethod", "payment"], due: ["due_date", "dueDate", "payment_due_date"],
  lines: ["lines", "items", "line_items", "products", "invoice_lines", "lineItems", "details", "rows"],
  desc: ["description", "name", "item", "product", "item_description", "title", "product_name"], code: ["code", "item_code", "sku", "product_code"],
  qty: ["quantity", "qty", "amount_qty"], unit: ["unit", "unit_of_measure", "uom", "measurement_unit"],
  up: ["unit_price", "price", "unitPrice", "price_per_unit", "unit_net_price"], disc: ["discount_pct", "discount", "discount_percent", "discountPct"],
  lnet: ["net_amount", "net", "net_value", "line_total", "netAmount", "amount", "total", "value"], lvat: ["vat_pct", "vat_rate", "vatRate", "tax_rate", "vat_percent", "vat"],
};
function normalizeResult(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sup = pick(r, ["supplier", "seller", "issuer", "vendor", "from"]) || {};
  const buy = pick(r, ["buyer", "customer", "client", "recipient", "to"]);
  const inv = pick(r, ["invoice", "document", "header", "invoice_details", "summary"]) || {};
  const both = (keys) => { const v = pick(inv, keys); return v !== undefined ? v : pick(r, keys); };
  const party = (o) => o && typeof o === "object" ? { name: pick(o, K.name) ?? null, afm: pick(o, K.afm) != null ? String(pick(o, K.afm)) : null, doy: pick(o, K.doy) ?? null, address: pick(o, K.address) ?? null, phone: pick(o, K.phone) ?? null, email: pick(o, K.email) ?? null } : null;
  let lines = pick(r, K.lines); if (!Array.isArray(lines)) lines = pick(inv, K.lines); if (!Array.isArray(lines)) lines = [];
  const vatPct = (v) => { const n = toNum(v); return n != null && n > 0 && n < 1 ? Math.round(n * 100) : n; };
  return {
    supplier: party(sup) || {}, buyer: party(buy),
    invoice: {
      number: both(K.number) != null ? String(both(K.number)) : null, date: toDate(both(K.date)), type: both(K.type) ?? null, mark: both(K.mark) != null ? String(both(K.mark)) : null,
      net_total: toNum(both(K.net)), vat_total: toNum(both(K.vat)), total: toNum(both(K.total)), payment_method: both(K.pay) ?? null, due_date: toDate(both(K.due)),
    },
    lines: lines.filter((l) => l && typeof l === "object").map((l) => ({
      code: pick(l, K.code) != null ? String(pick(l, K.code)) : null, description: pick(l, K.desc) ?? null, quantity: toNum(pick(l, K.qty)), unit: pick(l, K.unit) ?? null,
      unit_price: toNum(pick(l, K.up)), discount_pct: toNum(pick(l, K.disc)), net_amount: toNum(pick(l, K.lnet)), vat_pct: vatPct(pick(l, K.lvat)), category: pick(l, ["category", "kategoria"]) ?? null,
    })),
    notes: pick(r, ["notes", "note", "remarks"]) ?? null,
  };
}

// Αν το μοντέλο έδωσε 2 από τα 3 ποσά, υπολογίζουμε το τρίτο. Αν δεν έδωσε γραμμές, μία γραμμή με την καθαρή αξία.
function fixTotals(r) {
  const inv = r && r.invoice; if (!inv) return r;
  for (const who of [r.supplier, r.buyer]) if (who && who.afm != null) { const d = String(who.afm).replace(/\D/g, ""); who.afm = d.length === 9 ? d : null; }
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  let net = n(inv.net_total), vat = n(inv.vat_total), tot = n(inv.total);
  const r2 = (x) => Math.round(x * 100) / 100;
  if (tot == null && net != null && vat != null) tot = r2(net + vat);
  if (net == null && tot != null && vat != null) net = r2(tot - vat);
  if (vat == null && tot != null && net != null) vat = r2(tot - net);
  if (net == null && Array.isArray(r.lines) && r.lines.length) {
    const s = r.lines.reduce((a, l) => a + (n(l.net_amount) || 0), 0); if (s > 0) net = r2(s);
  }
  Object.assign(inv, { net_total: net, vat_total: vat, total: tot });
  for (const l of r.lines || []) { const q = n(l.quantity) > 0 ? l.quantity : 1, d = n(l.discount_pct) || 0, na = n(l.net_amount), up = n(l.unit_price); if (na > 0 && up > 0 && Math.abs(up * q * (1 - d / 100) - na) > na * 0.02) l.unit_price = Math.round(na / q / (1 - d / 100) * 10000) / 10000; }
  if (inv.mark != null && !/^\d{10,20}$/.test(String(inv.mark).replace(/\s/g, ""))) inv.mark = null;
  for (const l of r.lines || []) if (!(n(l.unit_price) > 0) && n(l.net_amount) > 0) l.unit_price = r2(l.net_amount / (n(l.quantity) > 0 ? l.quantity : 1));
  if ((!Array.isArray(r.lines) || !r.lines.length) && net != null) {
    r.lines = [{ code: null, description: inv.type || "Υπηρεσίες", quantity: 1, unit: null, unit_price: net, discount_pct: null, net_amount: net, vat_pct: null, category: null }];
  }
  return r;
}

const CLASSIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    assignments: { type: "ARRAY", items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, category: { type: "STRING" } }, required: ["i", "category"] } },
  },
  required: ["assignments"],
};

// Πόσο πλήρες είναι ένα αποτέλεσμα τιμολογίου (0–4). Κάτω από 3 = μισή ανάγνωση, ξαναδοκιμάζουμε.
function quality(r) {
  if (!r || !r.invoice) return 0;
  const i = r.invoice, n = (v) => typeof v === "number" && isFinite(v) && v !== 0;
  return (/^\d{4}-\d{2}-\d{2}$/.test(i.date || "") ? 1 : 0) + (n(i.total) ? 1 : 0) + (r.supplier && r.supplier.afm ? 1 : 0)
    + ((r.lines || []).some((l) => l && l.description && n(l.net_amount)) ? 1 : 0);
}

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

  const categories = (Array.isArray(body.categories) ? body.categories : []).map((c) => clean(c, 40)).filter((c) => c && !badCat(c)).slice(0, 80);
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
  let best = null; // καλύτερο (έστω και ελλιπές) αποτέλεσμα μέχρι τώρα
  const isInvoice = schema === SCHEMA;

  for (const model of models) {
    const left = 110000 - (Date.now() - started); // συνολικό όριο 110″
    if (left < 10000 || (best && Date.now() - started > 35000)) { tried.push(`${model}: δεν έμεινε χρόνος`); break; }

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
        const timer = setTimeout(() => ctrl.abort(), Math.max(5000, Math.min(110000 - (Date.now() - started) - 1000, 60000)));
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
        let result;
        try {
          const raw = JSON.parse(text);
          if (isInvoice) {
            // Στα logs του Netlify: τι ονόματα πεδίων έστειλε το Gemini (για διάγνωση)
            const l0 = Array.isArray(raw?.lines) ? raw.lines[0] : Array.isArray(raw?.items) ? raw.items[0] : null;
            console.log("extract", model, thinking ? "low" : "full", JSON.stringify({ top: Object.keys(raw || {}), invoice: raw?.invoice ? Object.keys(raw.invoice) : null, line: l0 ? Object.keys(l0) : null }));
          }
          result = isInvoice ? fixTotals(normalizeResult(raw)) : raw;
        } catch { result = null; }
        if (result && isInvoice) for (const l of result.lines || []) { if (l && badCat(l.category)) l.category = null; }
        if (result && !isInvoice) for (const a of result.assignments || []) { if (a && badCat(a.category)) a.category = ""; }
        if (result) {
          const out = { result, model, seconds: secs, tried, usage: data?.usageMetadata || null };
          if (!isInvoice) return json(out);
          const q = quality(result);
          if (q >= 3) return json(out);
          if (!best || q > best.q) best = { q, out };
          tried.push(`${model}${thinking ? "" : " (πλήρης)"}: ελλιπές ${q}/4`);
          // Μισή ανάγνωση: πρώτα ξανά το ίδιο μοντέλο με κανονική σκέψη, μετά το επόμενο μοντέλο.
          if (thinking && attempt === 0 && Date.now() - started < 35000) { thinking = false; continue; }
          break;
        }
        {
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

  if (best) { best.out.tried = tried; best.out.seconds = Math.round((Date.now() - started) / 1000); return json(best.out); }
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
