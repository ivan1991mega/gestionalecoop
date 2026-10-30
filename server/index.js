import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { pool, query, tx, initSchema } from "./db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS aperto (frontend può stare su GitHub Pages su dominio diverso)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------- autenticazione ----------------
   Login semplice a utente/password unici (default admin/admin).
   Personalizzabili con le variabili AUTH_USER / AUTH_PASS su Railway. */
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "admin";
// segreto per firmare i token; se non impostato ne genera uno a runtime
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function validToken(token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig !== expected) return false;
  try {
    const { t } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return (Date.now() - t) < 1000 * 60 * 60 * 24 * 30; // valido 30 giorni
  } catch { return false; }
}
// protegge tutte le API tranne login e health
function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (validToken(token)) return next();
  res.status(401).json({ error: "Non autorizzato" });
}

app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === AUTH_USER && pass === AUTH_PASS) {
    return res.json({ token: makeToken(user), user });
  }
  res.status(401).json({ error: "Utente o password errati" });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/* ---------------- helpers ---------------- */
const NORM = s => (s || "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
function pickCol(headers, keys) {
  for (const k of keys) {
    const i = headers.findIndex(h => NORM(h).includes(k));
    if (i >= 0) return i;
  }
  return -1;
}
function parseNum(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  let s = v.toString().trim().replace(/[^0-9.,\-]/g, "");
  if (s === "") return 0;
  // Se ci sono sia '.' che ',', l'ultimo separatore è quello decimale (formato IT: 1.234,56)
  if (s.includes(".") && s.includes(",")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");            // solo virgola -> decimale
  }
  return parseFloat(s) || 0;            // solo punto -> già decimale (es. "9.8")
}
// Categoria annidata Danea "Principale » Sotto » ..." -> solo il primo livello
function mainCategory(v) {
  if (!v) return "Senza categoria";
  const first = v.toString().split("»")[0].trim();
  return first || "Senza categoria";
}
// La colonna senza intestazione di Danea è "Nascosto?" (valori Sì/No)
function isHidden(v) {
  if (v == null) return false;
  const s = v.toString().trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // rimuove accenti: sì -> si
  return s === "si" || s === "s" || s === "yes" || s === "y" || s === "true" || s === "x" || s === "1";
}
async function nextBatch(client) {
  const r = await client.query("SELECT nextval('batch_seq') AS b");
  return Number(r.rows[0].b);
}

/* ---------------- health ---------------- */
app.get("/api/health", async (_req, res) => {
  try { await query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Da qui in poi tutte le rotte /api richiedono login.
app.use("/api", requireAuth);

/* ---------------- prodotti ---------------- */
app.get("/api/products", async (_req, res) => {
  const r = await query(
    "SELECT * FROM products WHERE archived = FALSE ORDER BY descr ASC");
  res.json(r.rows);
});

app.post("/api/products", async (req, res) => {
  const { code = "", descr, category = "Senza categoria", cost = 0, price = 0, stock = 0 } = req.body;
  if (!descr) return res.status(400).json({ error: "Descrizione obbligatoria" });
  try {
    const out = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO products (code, descr, category, cost, price, stock)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [code || null, descr, category, cost, price, stock]);
      const p = r.rows[0];
      if (Number(stock) !== 0) {
        await c.query(
          `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note)
           VALUES ($1,$2,$3,'carico',$4,$5,$6,$7,'Creazione prodotto')`,
          [p.id, p.code, p.descr, stock, stock, cost, price]);
      }
      return p;
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { code, descr, category, cost, price, stock } = req.body;
  try {
    const out = await tx(async (c) => {
      const cur = (await c.query("SELECT * FROM products WHERE id=$1", [id])).rows[0];
      if (!cur) throw new Error("Prodotto non trovato");
      const newStock = stock == null ? Number(cur.stock) : Number(stock);
      const r = await c.query(
        `UPDATE products SET
           code=$1, descr=$2, category=$3, cost=$4, price=$5, stock=$6, updated_at=now()
         WHERE id=$7 RETURNING *`,
        [ code ?? cur.code, descr ?? cur.descr, category ?? cur.category,
          cost ?? cur.cost, price ?? cur.price, newStock, id ]);
      const p = r.rows[0];
      // se cambia la giacenza manualmente -> movimento di rettifica
      const delta = newStock - Number(cur.stock);
      if (delta !== 0) {
        await c.query(
          `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note)
           VALUES ($1,$2,$3,'rettifica',$4,$5,$6,$7,'Modifica manuale')`,
          [p.id, p.code, p.descr, delta, newStock, p.cost, p.price]);
      }
      return p;
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await query("UPDATE products SET archived=TRUE, updated_at=now() WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- import Danea (Excel) ----------------
   Upsert per codice; crea movimenti 'import' con il delta di giacenza. */
app.post("/api/import", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessun file" });
  // mode: 'sync' (allinea giacenza al file) | 'add' (somma le giacenze del file)
  const mode = (req.body.mode || "sync");
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });

    let hIdx = rows.findIndex(r => r.filter(c => c !== "").length >= 2);
    if (hIdx < 0) hIdx = 0;
    const headers = rows[hIdx];
    // "cod. a barre" contiene "cod": lo cerco PRIMA e lo escludo dal match del codice articolo
    const cBar = pickCol(headers, ["codabarre", "codiceabarre", "barcode", "ean", "abarre"]);
    const cDesc = pickCol(headers, ["descrizione", "descr", "articolo", "nome", "prodotto"]);
    let cCode = -1;
    for (const k of ["codice", "cod"]) {
      const idx = headers.findIndex((h, j) => j !== cBar && NORM(h).includes(k));
      if (idx >= 0) { cCode = idx; break; }
    }
    const cCat = pickCol(headers, ["categoria", "famiglia", "gruppo", "reparto"]);
    // Danea: "Listino 1 (ivato)" è il prezzo di vendita
    const cPrice = pickCol(headers, ["listino", "prezzo", "vendita", "ivato"]);
    const cCost = pickCol(headers, ["costo", "acquisto", "carico"]);   // opzionale, spesso assente
    const cStock = pickCol(headers, ["giacenza", "giac", "quantita", "qta", "disponibilit", "stock", "esistenza"]);
    // Colonna "Nascosto?" di Danea: di solito la prima, senza intestazione (valori Sì/No)
    const cHidden = headers.findIndex(h => { const n = NORM(h); return n === "nascosto" || n === ""; });
    if (cDesc < 0) return res.status(400).json({ error: "Colonna Descrizione non trovata nel file" });

    const summary = { created: 0, updated: 0, movements: 0, rows: 0, skipped: 0 };

    await tx(async (c) => {
      const batch = await nextBatch(c);
      for (let i = hIdx + 1; i < rows.length; i++) {
        const r = rows[i];
        const descr = (r[cDesc] ?? "").toString().trim();
        // salta righe vuote, riga-totale (descrizione numerica senza codice) e prodotti nascosti
        if (!descr) continue;
        const code = cCode >= 0 ? (r[cCode] ?? "").toString().trim() : "";
        if (!code && /^\d+$/.test(descr)) { continue; }   // riga-totale finale di Danea
        if (cHidden >= 0 && isHidden(r[cHidden])) { summary.skipped++; continue; }
        summary.rows++;
        const cat = cCat >= 0 ? mainCategory(r[cCat]) : "Senza categoria";
        const price = cPrice >= 0 ? parseNum(r[cPrice]) : 0;
        const cost = cCost >= 0 ? parseNum(r[cCost]) : 0;
        const fileStock = cStock >= 0 ? parseNum(r[cStock]) : 0;

        let existing = null;
        if (code) {
          existing = (await c.query("SELECT * FROM products WHERE code=$1", [code])).rows[0] || null;
        }

        if (existing) {
          const prevStock = Number(existing.stock);
          const newStock = mode === "add" ? prevStock + fileStock : fileStock;
          await c.query(
            `UPDATE products SET descr=$1, category=$2, cost=$3, price=$4, stock=$5, archived=FALSE, updated_at=now()
             WHERE id=$6`,
            [descr, cat, cost, price, newStock, existing.id]);
          const delta = newStock - prevStock;
          if (delta !== 0) {
            await c.query(
              `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note, batch_id)
               VALUES ($1,$2,$3,'import',$4,$5,$6,$7,$8,$9)`,
              [existing.id, code, descr, delta, newStock, cost, price,
               mode === "add" ? "Carico da Danea" : "Allineamento da Danea", batch]);
            summary.movements++;
          }
          summary.updated++;
        } else {
          const p = (await c.query(
            `INSERT INTO products (code, descr, category, cost, price, stock)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [code || null, descr, cat, cost, price, fileStock])).rows[0];
          if (fileStock !== 0) {
            await c.query(
              `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note, batch_id)
               VALUES ($1,$2,$3,'import',$4,$5,$6,$7,'Nuovo da Danea',$8)`,
              [p.id, code, descr, fileStock, fileStock, cost, price, batch]);
            summary.movements++;
          }
          summary.created++;
        }
      }
    });
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- vendita (cassa) ---------------- */
app.post("/api/sales", async (req, res) => {
  const { items = [], discount = 0, cash = null } = req.body;
  if (!items.length) return res.status(400).json({ error: "Carrello vuoto" });
  try {
    const sale = await tx(async (c) => {
      const batch = await nextBatch(c);
      let subtotal = 0;
      const resolved = [];
      for (const it of items) {
        const p = (await c.query("SELECT * FROM products WHERE id=$1", [it.id])).rows[0];
        if (!p) throw new Error("Prodotto non trovato: " + it.id);
        const qty = Number(it.qty);
        if (qty <= 0) continue;
        if (Number(p.stock) < qty) throw new Error("Giacenza insufficiente: " + p.descr);
        const line = Number(p.price) * qty;
        subtotal += line;
        resolved.push({ p, qty, line });
      }
      let disc = Number(discount) || 0;
      if (disc < 0) disc = 0;
      if (disc > subtotal) disc = subtotal;
      const total = subtotal - disc;
      const change = cash != null ? Number(cash) - total : null;

      const saleRow = (await c.query(
        `INSERT INTO sales (subtotal, discount, total, cash, change)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [subtotal, disc, total, cash, change])).rows[0];

      for (const { p, qty, line } of resolved) {
        const newStock = Number(p.stock) - qty;
        await c.query("UPDATE products SET stock=$1, updated_at=now() WHERE id=$2", [newStock, p.id]);
        await c.query(
          `INSERT INTO sale_items (sale_id, product_id, descr, qty, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [saleRow.id, p.id, p.descr, qty, p.price, line]);
        await c.query(
          `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note, batch_id)
           VALUES ($1,$2,$3,'vendita',$4,$5,$6,$7,$8,$9)`,
          [p.id, p.code, p.descr, -qty, newStock, p.cost, p.price, "Scontrino #" + saleRow.id, batch]);
      }
      return { ...saleRow, items: resolved.map(r => ({ descr: r.p.descr, qty: r.qty, unit_price: r.p.price, line_total: r.line })) };
    });
    res.json(sale);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- storico & report ---------------- */
app.get("/api/movements", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const kind = req.query.kind;
  const params = [];
  let where = "";
  if (kind) { params.push(kind); where = "WHERE kind = $1"; }
  params.push(limit);
  const r = await query(
    `SELECT * FROM movements ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  res.json(r.rows);
});

app.get("/api/sales", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const r = await query(
    `SELECT s.*, COALESCE(json_agg(json_build_object(
        'id', si.id, 'product_id', si.product_id, 'descr', si.descr,
        'qty', si.qty, 'qty_returned', si.qty_returned,
        'unit_price', si.unit_price, 'line_total', si.line_total
      ) ORDER BY si.id) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
     FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
     GROUP BY s.id ORDER BY s.created_at DESC LIMIT $1`, [limit]);
  res.json(r.rows);
});

/* ---------------- storno totale di uno scontrino ----------------
   Rimette in giacenza tutta la merce non ancora resa, marca lo scontrino
   come stornato e registra i movimenti. Non cancella nulla. */
app.post("/api/sales/:id/void", async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body && req.body.reason || "").toString().slice(0, 300);
  try {
    const out = await tx(async (c) => {
      const sale = (await c.query("SELECT * FROM sales WHERE id=$1", [id])).rows[0];
      if (!sale) throw new Error("Scontrino non trovato");
      if (sale.voided) throw new Error("Scontrino già stornato");
      const items = (await c.query("SELECT * FROM sale_items WHERE sale_id=$1", [id])).rows;
      const batch = await nextBatch(c);
      for (const it of items) {
        const toReturn = Number(it.qty) - Number(it.qty_returned);
        if (toReturn > 0 && it.product_id) {
          const p = (await c.query("SELECT * FROM products WHERE id=$1", [it.product_id])).rows[0];
          if (p) {
            const newStock = Number(p.stock) + toReturn;
            await c.query("UPDATE products SET stock=$1, updated_at=now() WHERE id=$2", [newStock, p.id]);
            await c.query(
              `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note, batch_id)
               VALUES ($1,$2,$3,'storno',$4,$5,$6,$7,$8,$9)`,
              [p.id, p.code, p.descr, toReturn, newStock, p.cost, p.price,
               "Storno scontrino #" + id + (reason ? " · " + reason : ""), batch]);
          }
        }
        await c.query("UPDATE sale_items SET qty_returned = qty WHERE id=$1", [it.id]);
      }
      const s = (await c.query(
        `UPDATE sales SET voided=TRUE, void_reason=$1, voided_at=now() WHERE id=$2 RETURNING *`,
        [reason || null, id])).rows[0];
      return s;
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------------- storno parziale di una riga ----------------
   Rende `qty` pezzi di una singola riga: torna in giacenza, aggiorna la riga
   e ricalcola i totali dello scontrino. */
app.post("/api/sales/:id/return-line", async (req, res) => {
  const saleId = Number(req.params.id);
  const { itemId, qty, reason = "" } = req.body || {};
  const retQty = Number(qty);
  if (!itemId || !(retQty > 0)) return res.status(400).json({ error: "Quantità da rendere non valida" });
  try {
    const out = await tx(async (c) => {
      const sale = (await c.query("SELECT * FROM sales WHERE id=$1", [saleId])).rows[0];
      if (!sale) throw new Error("Scontrino non trovato");
      if (sale.voided) throw new Error("Scontrino già stornato");
      const it = (await c.query("SELECT * FROM sale_items WHERE id=$1 AND sale_id=$2", [Number(itemId), saleId])).rows[0];
      if (!it) throw new Error("Riga non trovata");
      const residua = Number(it.qty) - Number(it.qty_returned);
      if (retQty > residua) throw new Error("Puoi rendere al massimo " + residua + " pezzi di questa riga");

      // rimetti in giacenza
      const batch = await nextBatch(c);
      if (it.product_id) {
        const p = (await c.query("SELECT * FROM products WHERE id=$1", [it.product_id])).rows[0];
        if (p) {
          const newStock = Number(p.stock) + retQty;
          await c.query("UPDATE products SET stock=$1, updated_at=now() WHERE id=$2", [newStock, p.id]);
          await c.query(
            `INSERT INTO movements (product_id, code, descr, kind, qty, stock_after, unit_cost, unit_price, note, batch_id)
             VALUES ($1,$2,$3,'storno',$4,$5,$6,$7,$8,$9)`,
            [p.id, p.code, p.descr, retQty, newStock, p.cost, p.price,
             "Storno parziale scontrino #" + saleId + (reason ? " · " + reason : ""), batch]);
        }
      }
      // aggiorna la riga
      await c.query("UPDATE sale_items SET qty_returned = qty_returned + $1 WHERE id=$2", [retQty, it.id]);

      // ricalcola i totali dello scontrino sulle quantità nette (qty - qty_returned)
      const rows = (await c.query("SELECT qty, qty_returned, unit_price FROM sale_items WHERE sale_id=$1", [saleId])).rows;
      let subtotal = 0;
      for (const r of rows) subtotal += (Number(r.qty) - Number(r.qty_returned)) * Number(r.unit_price);
      let discount = Number(sale.discount) || 0;
      if (discount > subtotal) discount = subtotal;
      const total = subtotal - discount;
      // se tutte le righe sono rese, marca lo scontrino come stornato
      const allReturned = rows.every(r => Number(r.qty_returned) >= Number(r.qty));
      const s = (await c.query(
        `UPDATE sales SET subtotal=$1, discount=$2, total=$3,
           voided = $4, voided_at = CASE WHEN $4 THEN now() ELSE voided_at END
         WHERE id=$5 RETURNING *`,
        [subtotal, discount, total, allReturned, saleId])).rows[0];
      return s;
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/report", async (_req, res) => {
  const stock = (await query(
    `SELECT COUNT(*)::int AS articoli,
            COALESCE(SUM(stock),0) AS pezzi,
            COALESCE(SUM(stock*cost),0) AS valore_costo,
            COALESCE(SUM(stock*price),0) AS valore_vendita
     FROM products WHERE archived=FALSE`)).rows[0];
  const today = (await query(
    `SELECT COALESCE(SUM(total),0) AS incasso, COUNT(*)::int AS scontrini
     FROM sales WHERE voided=FALSE AND created_at::date = now()::date`)).rows[0];
  const month = (await query(
    `SELECT COALESCE(SUM(total),0) AS incasso, COUNT(*)::int AS scontrini
     FROM sales WHERE voided=FALSE AND date_trunc('month',created_at)=date_trunc('month',now())`)).rows[0];
  res.json({ stock, today, month });
});

/* ---------------- export Excel magazzino ---------------- */
app.get("/api/export", async (_req, res) => {
  try {
    const r = await query(
      `SELECT code, descr, category, cost, price, stock
       FROM products WHERE archived = FALSE
       ORDER BY category, descr`);
    const rows = r.rows.map(p => ({
      Codice: p.code || "",
      Descrizione: p.descr || "",
      Categoria: p.category || "",
      Costo: Number(p.cost) || 0,
      Prezzo: Number(p.price) || 0,
      Giacenza: Number(p.stock) || 0
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { header: ["Codice","Descrizione","Categoria","Costo","Prezzo","Giacenza"] });
    // larghezze colonne comode
    ws["!cols"] = [
      { wch: 14 }, { wch: 42 }, { wch: 18 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Magazzino");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="magazzino-uniformi-${stamp}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- static frontend ---------------- */
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

const PORT = process.env.PORT || 3000;
(async () => {
  try { await initSchema(); }
  catch (e) { console.error("Errore init schema:", e.message); }
  app.listen(PORT, () => console.log("🚀 Magazzino Uniformi server su :" + PORT));
})();
