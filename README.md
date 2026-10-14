# PriceArmor (beta)

Σάρωση τιμολογίων προμηθευτών με Gemini, καρτέλες προμηθευτών, ιστορικό τιμών και ειδοποιήσεις αλλαγής τιμών.

## Αρχεία
- `index.html`: landing page του PriceArmor.
- `app/index.html`: η εφαρμογή (React μέσω CDN). Τα δεδομένα αποθηκεύονται στη συσκευή (IndexedDB).
- `netlify/edge-functions/extract.js` — `/api/extract`: στέλνει τις φωτογραφίες/PDF στο Gemini και επιστρέφει JSON.
- `netlify.toml`

## Στήσιμο
1. Κλειδί Gemini: https://aistudio.google.com/apikey → Create API key.
2. Netlify → Add new site → Import from GitHub → αυτό το repo (χωρίς build command, publish `.`).
3. Site configuration → Environment variables:
   - `GEMINI_API_KEY` = το κλειδί
   - (προαιρετικά) `GEMINI_MODEL` = π.χ. `gemini-3.8-flash` (προεπιλογή)
4. Deploys → Trigger deploy.

## Σημειώσεις δοκιμαστικής έκδοσης
- Δεδομένα μόνο στη συσκευή/browser. Ρυθμίσεις → Λήψη αντιγράφου για backup.
- Δωρεάν Gemini: μόνο για δοκιμές και δικά μας τιμολόγια. Για πελάτες ενεργοποιείται billing στο ίδιο Google project.
- Επόμενα: Supabase (λογαριασμοί, πολλές συσκευές), πληρωμές/υπόλοιπα προμηθευτών, προώθηση email.
