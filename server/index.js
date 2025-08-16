// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import compression from "compression";
import { OpenAI } from "openai";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import { TextDecoder } from "util";

dotenv.config();

/* ────────────────────────────────────────────────────────────────────────────
   Config & Clients
   ──────────────────────────────────────────────────────────────────────────── */

const OLLAMA_URL         = process.env.OLLAMA_URL || "http://homebase.lab49.de:11434";
const OLLAMA_MODEL       = process.env.OLLAMA_MODEL || "mistral:instruct";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || process.env.OLLAMA_MODEL_EMBED || "bge-m3";

const ZILLIZ_URI         = process.env.ZILLIZ_URI;
const ZILLIZ_TOKEN       = process.env.ZILLIZ_TOKEN;
const MILVUS_COLLECTION  = process.env.MILVUS_COLLECTION || "betriebe_chunks_dev";

const EMBEDDINGS_PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "ollama").toLowerCase();
const OPENAI_EMBED_MODEL  = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const milvus = new MilvusClient({ address: ZILLIZ_URI, token: ZILLIZ_TOKEN });

/* ────────────────────────────────────────────────────────────────────────────
   Logging Helpers
   ──────────────────────────────────────────────────────────────────────────── */

const log = {
  info:  (...a) => console.log(  "ℹ️ ", ...a),
  ok:    (...a) => console.log(  "✅", ...a),
  warn:  (...a) => console.warn( "⚠️ ", ...a),
  err:   (...a) => console.error("❌", ...a),
  step:  (...a) => console.log(  "🔹", ...a),
  send:  (...a) => console.log(  "📤", ...a),
  recv:  (...a) => console.log(  "📥", ...a),
  vect:  (...a) => console.log(  "🧭", ...a),
  chat:  (...a) => console.log(  "💬", ...a),
  dbg:   (...a) => console.log(  "🔎", ...a),
};

log.ok("Server-Konfiguration");
log.info("🌍 OLLAMA_URL        :", OLLAMA_URL);
log.info("💬 CHAT MODEL        :", OLLAMA_MODEL);
log.info("🧭 EMBED MODEL       :", EMBEDDINGS_PROVIDER === "ollama" ? `${OLLAMA_EMBED_MODEL} (ollama)` : `${OPENAI_EMBED_MODEL} (openai)`);
log.info("📦 ZILLIZ_URI        :", ZILLIZ_URI ? "[ok]" : "(fehlt)");
log.info("📦 MILVUS_COLLECTION :", MILVUS_COLLECTION);

/* ────────────────────────────────────────────────────────────────────────────
   App Setup
   ──────────────────────────────────────────────────────────────────────────── */

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

// Kompression NICHT für SSE
app.use((req, res, next) => {
  if (req.path === "/chat") {
    res.setHeader("Content-Encoding", "identity");
    return next();
  }
  return compression()(req, res, next);
});

/* ────────────────────────────────────────────────────────────────────────────
   Embeddings
   ──────────────────────────────────────────────────────────────────────────── */

// bge-m3 unter Ollama kann leeres Embedding liefern, wenn "input" verwendet wird → Fallback auf "prompt"
async function embedWithOllama(text) {
  const url = `${OLLAMA_URL}/api/embeddings`;

  // 1) input
  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
  }).catch(() => null);

  if (!res || !res.ok) {
    throw new Error(`Ollama embeddings HTTP ${res?.status} ${res?.statusText}`);
  }

  let body = await res.json();
  let vec = body?.embedding || body?.data?.[0]?.embedding || [];
  if (Array.isArray(vec) && vec.length > 0) return vec;

  // 2) prompt-Fallback
  log.warn("↪️ Embedding input→prompt Fallback (input ergab leeres Embedding).");
  res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embeddings (prompt) HTTP ${res.status} ${res.statusText}`);
  }
  body = await res.json();
  vec = body?.embedding || body?.data?.[0]?.embedding || [];
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Ollama lieferte kein Embedding (auch nicht mit prompt).");
  }
  return vec;
}

async function embed(text) {
  if (EMBEDDINGS_PROVIDER === "openai") {
    if (!openai) throw new Error("OPENAI_API_KEY fehlt, Embedding via OpenAI nicht möglich.");
    const r = await openai.embeddings.create({ model: OPENAI_EMBED_MODEL, input: text });
    const v = r.data?.[0]?.embedding;
    if (!v) throw new Error("OpenAI Embedding leer.");
    return v;
  }
  return embedWithOllama(text);
}

/* ────────────────────────────────────────────────────────────────────────────
   Milvus Helpers
   ──────────────────────────────────────────────────────────────────────────── */

function getDimFromFields(fields) {
  const vf = (fields || []).find(f => (f.name === "vector") && (f.data_type === "FloatVector" || f.type === "FloatVector"));
  if (!vf) return { dim: undefined, source: "no_vector_field" };

  // type_params kann als Array [{key,value}] oder Objekt {dim: "..."} kommen
  let dim;
  const tp = vf.type_params;
  if (Array.isArray(tp)) {
    const x = tp.find(p => p.key?.toLowerCase?.() === "dim");
    dim = x?.value;
  } else if (tp && typeof tp === "object") {
    dim = tp.dim;
  }
  if (typeof dim === "string") dim = parseInt(dim, 10);
  return { dim, source: "schema" };
}

async function getCollectionStats(collection) {
  try {
    const desc = await milvus.describeCollection({ collection_name: collection });

    const { dim, source } = getDimFromFields(desc?.schema?.fields || desc?.fields || []);

    // RowCount bei Zilliz Serverless ist oft nicht zuverlässig → wir melden neutral
    const info = {
      name: desc?.name || collection,
      db: desc?.db_name,
      loaded: "n/a",
      rowCount: 0,                // bewusst 0; wir verlassen uns stattdessen auf Suchresultate
      dim,
      dim_source: source,
      fields: (desc?.schema?.fields || desc?.fields || []).map(f => ({
        name: f.name,
        type: f.data_type || f.type,
        dim: (Array.isArray(f.type_params)
          ? (f.type_params.find(p => p.key?.toLowerCase?.() === "dim")?.value)
          : f.type_params?.dim) || undefined
      }))
    };

    return info;
  } catch (e) {
    log.warn("Konnte Collection-Stats nicht ermitteln:", e?.message || e);
    return null;
  }
}

function rowsFromMilvusSearch(raw) {
  const results = raw?.results || raw?.data || [];
  if (!Array.isArray(results)) return [];
  return results.map(r => {
    const fields = r.fields || r._fields || r;
    const chunk = fields.chunk ?? r.chunk ?? (r.output_fields?.chunk);
    const score = typeof r.score === "number"
      ? r.score
      : (typeof r.distance === "number" ? r.distance : 0);
    return {
      score,
      id: fields.id ?? r.id ?? null,
      title: fields.title ?? r.title ?? null,
      ort: fields.ort ?? r.ort ?? null,
      chunk: chunk ?? "",
      ausbildungsberufe: fields.ausbildungsberufe ?? r.ausbildungsberufe ?? "",
      berufsbereiche: fields.berufsbereiche ?? r.berufsbereiche ?? "",
      mitarbeiter: fields.mitarbeiter ?? r.mitarbeiter ?? null,
      auszubildende: fields.auszubildende ?? r.auszubildende ?? null,
      nid: fields.nid ?? r.nid ?? null,
    };
  });
}

async function milvusSearch({ collection, vector, limit, output_fields }) {
  const payload = {
    collection_name: collection,
    vector, // einzelner Vektor (number[])
    limit: Number(limit),
    output_fields,
    filter: "",
    search_params: {
      anns_field: "vector",
      topk: String(limit),
      metric_type: "COSINE",
      params: JSON.stringify({ nprobe: 16, ef: 128 }),
    },
    consistency_level: "Strong",
  };

  const raw = await milvus.search(payload);
  const rows = rowsFromMilvusSearch(raw);
  const keys = Object.keys(raw || {});
  log.dbg(`Milvus search (form=vector, metric=COSINE) → ${rows.length} Treffer (keys=${JSON.stringify(keys)})`);
  return rows;
}

async function milvusFieldFallback({ ort, beruf, limit = 20 }) {
  try {
    const clauses = [];
    if (ort) {
      clauses.push(`ort like "${String(ort).replace(/"/g, '\\"')}%"`);
    }
    if (beruf) {
      clauses.push(`(berufsbereiche like "%${String(beruf).replace(/"/g, '\\"')}%" OR ausbildungsberufe like "%${String(beruf).replace(/"/g, '\\"')}%")`);
    }
    if (!clauses.length) return [];

    const expr = clauses.join(" AND ");
    const out = ["id","title","ort","chunk","ausbildungsberufe","berufsbereiche","mitarbeiter","auszubildende","nid"];
    const r = await milvus.query({
      collection_name: MILVUS_COLLECTION,
      expr,
      output_fields: out,
      limit
    });
    return r?.data || [];
  } catch (e) {
    log.warn("Feld-Fallback fehlgeschlagen:", e?.message || e);
    return [];
  }
}

async function queryCompanyFacts(titleLike) {
  const title = String(titleLike || "").replace(/"/g, '\\"').trim();
  if (!title) return [];
  const expr = `title like "${title}%"`;
  const out = ["id","nid","title","ort","mitarbeiter","auszubildende","berufsbereiche","ausbildungsberufe","ansprechpartner"];
  const res = await milvus.query({
    collection_name: MILVUS_COLLECTION,
    expr,
    output_fields: out,
    limit: 100
  });
  return res?.data || [];
}

function aggregateFacts(rows) {
  if (!rows?.length) return null;
  const first = rows[0];
  const joinUniq = (arr) => [...new Set(
    arr
      .filter(Boolean)
      .join("||")
      .split(/[,;|]{1,2}/)
      .map(s => s.trim())
      .filter(Boolean)
  )];

  const mitarbeiter = rows.map(r => r.mitarbeiter).filter(v => Number.isFinite(v)).at(0) ?? null;
  const auszubildende = rows.map(r => r.auszubildende).filter(v => Number.isFinite(v)).at(0) ?? null;
  const berufsbereiche = joinUniq(rows.map(r => r.berufsbereiche || ""));
  const ausbildungsberufe = joinUniq(rows.map(r => r.ausbildungsberufe || ""));
  const ansprechpartner = rows.map(r => r.ansprechpartner).filter(Boolean).at(0) ?? null;

  return {
    id: first.id,
    nid: first.nid,
    title: first.title,
    ort: first.ort,
    mitarbeiter,
    auszubildende,
    berufsbereiche,
    ausbildungsberufe,
    ansprechpartner
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Intent & Prompt Utils
   ──────────────────────────────────────────────────────────────────────────── */

function detectIntent(userText = "") {
  const t = String(userText).toLowerCase().trim();

  const listTriggers = [
    "zeige","zeig","liste","list","such","finde","suche",
    "betriebe","unternehmen","firmen","in ","bei ","nahe ","umkreis"
  ];

  const qaTriggers = [
    "wieviel","wie viele","anzahl","hat","haben",
    "berufsbereiche","welche berufsbereiche","ausbildungsberufe","was bietet",
    "email","telefon","website","ansprechpartner","kontakt"
  ];

  const berufKeywords = ["maler","friseur","elektr", "mechatron", "kauf", "logistik", "bau", "pfleg", "it", "informat"];
  const hasBeruf = berufKeywords.some(k => t.includes(k));
  const whereBecome = /(^|\s)wo\s+kann\s+ich\s+.+werden\??$/.test(t);
  const whereFind   = /(^|\s)wo\s+finde\s+ich\s+.+/.test(t);

  if ((whereBecome || whereFind) && hasBeruf) return "cards";

  const hasList = listTriggers.some(w => t.includes(w));
  const hasQA   = qaTriggers.some(w => t.includes(w));

  if (hasQA && !hasList) return "qa";
  if (hasList && !hasQA) return "cards";

  if (hasBeruf && /\bin\s+[a-zäöüß\- ]+/.test(t)) return "cards";
  return "qa";
}

function extractHints(userText = "") {
  const t = userText.toLowerCase();
  const mOrt = t.match(/\bin\s+([a-zäöüß\.\- ]{2,})/i);
  const ort = mOrt ? mOrt[1].trim().replace(/[\.!?,;:]+$/, "") : null;

  const berufKeywords = ["maler","friseur","elektr","mechatron","kauf","logistik","bau","pfleg","it","informat"];
  const beruf = berufKeywords.find(k => t.includes(k)) || null;

  return { ort, beruf };
}

function buildQaContext(factsList, topVectorHits = []) {
  const factsBlock = (factsList || []).map(f => {
    const bb = f.berufsbereiche?.join?.("; ") || f.berufsbereiche || "—";
    const ab = f.ausbildungsberufe?.join?.("; ") || f.ausbildungsberufe || "—";
    return [
      `- Betrieb: ${f.title} (Ort: ${f.ort})`,
      `  Mitarbeiter: ${f.mitarbeiter ?? "—"}`,
      `  Auszubildende: ${f.auszubildende ?? "—"}`,
      `  Berufsbereiche: ${bb}`,
      `  Ausbildungsberufe: ${ab}`
    ].join("\n");
  }).join("\n");

  const snippets = (topVectorHits || [])
    .map(h => (h.chunk || "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map(s => (s.length > 600 ? s.slice(0,600) + " …" : s));

  const snippetBlock = snippets.map(s => `- "${s.replaceAll('"','\\"')}"`).join("\n");

  return `KONTEXT (Fakten):\n${factsBlock || "- (keine exakten Faktenzeilen gefunden)"}\n\nKONTEXT (Ausschnitte):\n${snippetBlock || "- (keine Textausschnitte)"}\n`;
}

function needsBerufeLink(userText = "") {
  const t = userText.toLowerCase();
  return t.includes("ausbildungsberuf") || t.includes("berufe") || t.includes("berufsbereich");
}

const QA_SYSTEM_PROMPT = process.env.QA_SYSTEM_PROMPT || `
Du bist ein Assistent für die Ausbildungsregion Osnabrück.
Antworte ausschließlich auf Deutsch und NUR anhand des bereitgestellten Kontexts.
Wenn eine Information im Kontext nicht vorhanden ist, schreibe klar:
"Dazu habe ich keine Angabe im Datensatz."
Gib keine HTML-Cards und keine externen Links aus.
Sei präzise und knapp. Verwende Stichpunkte nur, wenn es hilft.
`;

/* ────────────────────────────────────────────────────────────────────────────
   /chat – SSE Endpoint
   ──────────────────────────────────────────────────────────────────────────── */

app.post("/chat", async (req, res) => {
  const decoder = new TextDecoder("utf-8");

  const sseHeaders = () => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");  // Proxy-Buffering aus (z.B. Nginx)
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  };
  const sseSend = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const sseDone = () => res.write("data: [DONE]\n\n");

  try {
    const settings  = req.body?.settings || {};
    const userText  = String(req.body?.message || "").trim();

    log.recv("/chat Anfrage:", JSON.stringify({ message: userText, widgetId: req.body?.widgetId, settings }, null, 2));
    if (!userText) return res.status(400).json({ error: "message fehlt" });

    // SSE Start
    sseHeaders();
    sseSend({ init: true });  // echtes Event → Frontend öffnet Stream sicher

    // 1) Embedding
    log.chat("Nutzerfrage:", userText);
    log.step("Starte Embedding-Erzeugung …");
    const queryVec = await embed(userText);
    log.ok(`Embedding erzeugt (Dimension: ${queryVec.length})`);

    // 2) Collection-Infos
    const stats = await getCollectionStats(MILVUS_COLLECTION);
    if (stats) {
      log.info("Collection:", JSON.stringify(stats, null, 2));
      if (stats.dim && stats.dim !== queryVec.length) {
        log.warn(`Schema-Mismatch: vector-dim=${stats.dim} ≠ embed-dim=${queryVec.length} (DB=${stats.db || "n/a"})`);
      }
      if (!stats.rowCount) {
        log.info("Hinweis: RowCount bei Zilliz Serverless oft nicht zuverlässig. Relevanter sind Such-Treffer.");
      }
    }

    // 3) Vektor-Suche
    log.step("Starte Milvus-Suche …");
    let vectorHits = [];
    try {
      vectorHits = await milvusSearch({
        collection: MILVUS_COLLECTION,
        vector: queryVec,
        limit: 20,
        output_fields: ["id","title","ort","chunk","ausbildungsberufe","berufsbereiche","mitarbeiter","auszubildende","nid"],
      });
    } catch (e) {
      log.warn("Milvus-Suche fehlgeschlagen:", e?.message || e);
    }
    const top5 = vectorHits.slice(0, 5).map(h => h.score);
    log.info("Top-5 Scores:", top5);
    const filteredVector = vectorHits.filter(h => typeof h.score === "number" ? (h.score >= 0.01) : true);
    log.info(`Gefilterte Treffer (>= 0.01): ${filteredVector.length}`);

    // 4) Intent & Hints
    const intent = detectIntent(userText);
    const { ort, beruf } = extractHints(userText);
    log.vect("Intent:", intent, "| Hints:", { ort, beruf });

    // 5) Feld-Fallback
    let fieldHits = [];
    try {
      fieldHits = await milvusFieldFallback({ ort, beruf, limit: 20 });
    } catch {
      fieldHits = [];
    }

    // 6) Merge + Dedupe
    const map = new Map();
    for (const r of [...filteredVector, ...fieldHits]) {
      const key = r.id || r.title || JSON.stringify(r);
      if (!map.has(key)) map.set(key, r);
    }
    const candidates = Array.from(map.values());
    const top = candidates.slice(0, 20);

    // 7) LIST/ CARDS → direkt JSON (ein Event) senden
    if (intent === "cards") {
      const items = top.slice(0, 6).map(r => {
        const ab = String(r.ausbildungsberufe || "")
          .split(/[,;|]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
        const pfad = r.nid
          ? `node/${r.nid}`
          : (r.pfad || `betrieb/${(r.title || "").toLowerCase().replace(/\s+/g, "-")}`);
        return {
          name: r.title || "(ohne Namen)",
          ort : r.ort   || "",
          pfad,
          ausbildungsberufe: ab
        };
      });
    
      const payload = {
        role: "assistant",
        type: "cards",
        items,
        includeBerufeLink: needsBerufeLink(userText)
      };
    
      sseSend(payload);   // << EIN einziges, sauberes Cards-Event
      sseDone();
      res.end();
      log.send("Cards-JSON an Client gesendet");
      return;
    }
    // 8) QA → gezielte Fakten zu Top-Titeln
    const topTitles = top.map(r => r.title).filter(Boolean).slice(0, 3);
    const facts = [];
    for (const t of topTitles) {
      try {
        const rows = await queryCompanyFacts(t);
        const agg  = aggregateFacts(rows);
        if (agg) facts.push(agg);
      } catch {/* ignore */}
    }

    const qaContext = buildQaContext(facts, top);

    // 9) LLM Streaming (reiner Text)
    const SYSTEM_PROMPT = QA_SYSTEM_PROMPT;
    const finalPrompt =
      `${SYSTEM_PROMPT}\n\n` +
      `${qaContext}\n` +
      `FRAGE: ${userText}\n` +
      `ANTWORT:\n`;

    log.step("Erzeuge Final-Prompt für Modell:", OLLAMA_MODEL);
    log.step("Sende Anfrage an Ollama:", OLLAMA_URL);

    const llmRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model : OLLAMA_MODEL,
        prompt: finalPrompt,
        stream: true
      }),
    });

    if (!llmRes.ok || !llmRes.body) {
      sseSend({ error: "Ollama-Fehler", status: llmRes.status, statusText: llmRes.statusText });
      sseDone();
      res.end();
      return;
    }

    log.step("Beginne LLM-Streaming …");
    for await (const chunk of llmRes.body) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.response) sseSend({ content: parsed.response });
          if (parsed.done) {
            sseDone();
            res.end();
            log.send("Antwort an Client gesendet (LLM-Streaming beendet)");
            return;
          }
        } catch {
          // ignore non-JSON
        }
      }
    }

    // falls kein "done" kam
    sseDone();
    res.end();
    log.send("Antwort an Client gesendet (LLM-Stream ohne done)");

  } catch (error) {
    log.err("Fehler im /chat-Handler:", error);
    try {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      sseSend({ error: String(error?.message || error) });
      sseDone();
      res.end();
    } catch {
      res.status(500).json({ error: "Interner Serverfehler" });
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   Feedback
   ──────────────────────────────────────────────────────────────────────────── */

app.post("/feedback", async (req, res) => {
  res.status(200).json({ message: "Feedback erhalten" });
});

/* ────────────────────────────────────────────────────────────────────────────
   Start
   ──────────────────────────────────────────────────────────────────────────── */

const PORT = process.env.PORT || 5544;
app.listen(PORT, () => {
  log.ok(`Server läuft auf Port ${PORT}`);
});