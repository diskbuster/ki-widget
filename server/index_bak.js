// server/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { TextDecoder } from 'util';

const app = express();
app.use(cors());
app.use(express.json());

/* ========= ENV ========= */
const OLLAMA_URL         = (process.env.OLLAMA_URL || 'http://homebase.lab49.de:11434').replace(/\/+$/, '');
const OLLAMA_CHAT_MODEL  = process.env.OLLAMA_CHAT_MODEL || process.env.CHAT_MODEL || 'mistral:instruct';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || process.env.OLLAMA_MODEL || 'bge-m3';
const OLLAMA_EMBED_MODE  = (process.env.OLLAMA_EMBED_MODE || 'prompt').toLowerCase(); // bge-* => 'prompt'

const ZILLIZ_URI         = process.env.ZILLIZ_URI || '';
const ZILLIZ_TOKEN       = process.env.ZILLIZ_TOKEN || '';
const MILVUS_COLLECTION  = process.env.MILVUS_COLLECTION || 'betriebe_chunks_dev';
const MILVUS_DATABASE    = process.env.MILVUS_DATABASE || ''; // z.B. db_310… für Zilliz-Projekt

const BASE_PROMPT        = process.env.BASE_PROMPT || '';

const MILVUS_MIN_SCORE   = Number.isFinite(Number(process.env.MILVUS_MIN_SCORE))
  ? Number(process.env.MILVUS_MIN_SCORE) : 0.0;
const MILVUS_LIMIT       = Number.isFinite(Number(process.env.MILVUS_LIMIT))
  ? Number(process.env.MILVUS_LIMIT) : 20;

console.log('✅ Server-Konfiguration');
console.log('🌍 OLLAMA_URL        :', OLLAMA_URL);
console.log('💬 CHAT MODEL        :', OLLAMA_CHAT_MODEL);
console.log('🧭 EMBED MODEL       :', OLLAMA_EMBED_MODEL, `(mode=${OLLAMA_EMBED_MODE})`);
console.log('📦 ZILLIZ_URI        :', ZILLIZ_URI ? '[ok]' : '(leer)');
console.log('📦 MILVUS_COLLECTION :', MILVUS_COLLECTION);
console.log('🗃  MILVUS_DATABASE   :', MILVUS_DATABASE || '(default)');
console.log('🎯 MILVUS_MIN_SCORE  :', MILVUS_MIN_SCORE);
console.log('🔢 MILVUS_LIMIT      :', MILVUS_LIMIT);

/* ========= Milvus ========= */
const milvus = new MilvusClient({ address: ZILLIZ_URI, token: ZILLIZ_TOKEN });
let currentDb = '(default)';

(async () => {
  try {
    if (MILVUS_DATABASE) {
      await milvus.useDatabase({ db_name: MILVUS_DATABASE });
      currentDb = MILVUS_DATABASE;
      console.log('🔐 useDatabase OK →', MILVUS_DATABASE);
    }
    const collList = await milvus.showCollections();
    const names = (collList?.data || []).map(c => c.name);
    if (!names.includes(MILVUS_COLLECTION)) {
      console.warn('⚠️ Collection im aktuellen Projekt nicht gefunden.');
      console.warn('📋 Verfügbare Collections:', names);
    } else {
      console.log('✅ Collection vorhanden im Projekt:', currentDb);
    }
  } catch (e) {
    console.warn('⚠️ Init warn:', e?.message || e);
  }
})();

/* ========= Helpers ========= */

function l2norm(arr) {
  let s = 0; for (const x of arr) s += x*x;
  return Math.sqrt(s);
}
function normalize(vec) {
  const n = l2norm(vec) || 1;
  return vec.map(v => v / n);
}

async function describeVectorIndex(collection) {
  try {
    const di = await milvus.describeIndex({ collection_name: collection, field_name: 'vector' });
    const desc = di?.index_descriptions?.[0] || {};
    // metric_type kann in params stecken
    const metric = kvGet(desc?.params, 'metric_type') || desc?.metric_type || 'UNKNOWN';
    return String(metric).toUpperCase();
  } catch { return 'UNKNOWN'; }
}

async function milvusSearchRobust({ collection, vector, limit, output_fields }) {
  // Welcher Metric-Typ ist am Index hinterlegt?
  const metricIndex = await describeVectorIndex(collection); // COSINE / IP / UNKNOWN

  // 1) Bevorzugte Form für @zilliz/milvus2-sdk-node: vector (Singular) + search_params
  const plan1 = {
    collection_name: collection,
    vector, // <-- Singular!
    limit: Number(limit),
    output_fields,
    filter: '', // keine Expr
    search_params: {
      anns_field: 'vector',
      topk: String(limit),
      metric_type: 'COSINE',
      params: JSON.stringify({ nprobe: 16, ef: 128 }),
    },
    consistency_level: 'Strong',
  };

  // 2) Fallback: vector + IP mit normalisiertem Query (falls Index nicht COSINE)
  const plan2 = {
    ...plan1,
    vector: normalize(vector),
    search_params: {
      ...plan1.search_params,
      metric_type: 'IP',
    },
  };

  // 3) Alternative Form: vectors (Plural) + verschachtelte search_params (PyMilvus-ähnlich)
  const plan3 = {
    collection_name: collection,
    vectors: [vector],
    search_params: {
      anns_field: 'vector',
      topk: String(limit),
      metric_type: 'COSINE',
      params: JSON.stringify({ nprobe: 16, ef: 128 }),
    },
    output_fields,
    consistency_level: 'Strong',
  };

  // 4) Alternative Form: data (manche SDK-Versionen akzeptieren das)
  const plan4 = {
    collection_name: collection,
    data: [vector],
    anns_field: 'vector',
    topk: String(limit),
    metric_type: 'COSINE',
    params: JSON.stringify({ nprobe: 16, ef: 128 }),
    output_fields,
    consistency_level: 'Strong',
  };

  // Wenn der Index nicht COSINE ist, starte mit IP-Variante (plan2), sonst mit plan1
  const plans = (metricIndex === 'COSINE') ? [plan1, plan3, plan4, plan2] : [plan2, plan1, plan3, plan4];

  for (const p of plans) {
    try {
      const raw = await milvus.search(p);
      const rows = rowsFromMilvusSearch(raw);
      const form =
        p.vector ? 'vector' :
        p.vectors ? 'vectors' :
        p.data ? 'data' : 'unknown';
      const metricUsed =
        p.search_params?.metric_type || p.metric_type || 'UNKNOWN';
      console.log(`🔍 Versuch (${metricUsed}, form=${form}) → ${rows.length} Treffer (keys=${JSON.stringify(Object.keys(raw||{}))})`);
      if (rows.length > 0) return rows;
    } catch (e) {
      console.warn('⚠️ milvus.search Versuch fehlgeschlagen:', e?.message || e);
    }
  }
  return [];
}

// Key-Value aus Objekt/Array/String-JSON ziehen
function kvGet(maybe, key) {
  if (!maybe) return undefined;
  if (typeof maybe === 'string') {
    try { return kvGet(JSON.parse(maybe), key); } catch {}
  }
  if (Array.isArray(maybe)) {
    const found = maybe.find(e =>
      String(e?.key || e?.Key || '').toLowerCase() === String(key).toLowerCase()
    );
    return found?.value ?? found?.Value;
  }
  if (typeof maybe === 'object') {
    const lower = Object.create(null);
    for (const k of Object.keys(maybe)) lower[k.toLowerCase()] = maybe[k];
    return lower[String(key).toLowerCase()];
  }
  return undefined;
}

function toIntOrUndef(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function findVectorField(desc) {
  const fields = desc?.schema?.fields || [];
  return fields.find(f =>
    f?.data_type === 'FloatVector' ||
    f?.data_type === 'FLOAT_VECTOR' ||
    f?.data_type === 101
  );
}

function getDimFromField(field) {
  if (!field) return undefined;
  let dim =
    kvGet(field.type_params, 'dim') ??
    kvGet(field.params, 'dim') ??
    kvGet(field.element_type_params, 'dim') ??
    kvGet(field.vector_param, 'dim') ??
    (typeof field.dim !== 'undefined' ? field.dim : undefined);
  return toIntOrUndef(dim);
}

function dimFromSchema(desc) {
  const vf = findVectorField(desc);
  if (!vf) return undefined;
  return getDimFromField(vf);
}

async function dimFromSampleRow(collection_name) {
  try {
    const q = await milvus.query({
      collection_name,
      expr: "id != ''",
      limit: 1,
      output_fields: ['vector'],
      consistency_level: 'Strong',
    });
    const row = Array.isArray(q?.data) ? q.data[0] : null;
    const v = row?.vector;
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') {
      const arr = Array.isArray(v.data) ? v.data
                : Array.isArray(v.values) ? v.values
                : undefined;
      if (Array.isArray(arr) && arr.length > 0) return arr.length;
      const d = Number(v.dim);
      if (Number.isFinite(d)) return d;
    }
  } catch (e) {
    console.warn('⚠️ dimFromSampleRow warn:', e?.message || e);
  }
  return undefined;
}

async function safeGetDimFromDB(collection_name, desc) {
  const d1 = dimFromSchema(desc);
  if (d1) return { dim: d1, source: 'schema' };
  const d2 = await dimFromSampleRow(collection_name);
  if (d2) return { dim: d2, source: 'sample-row' };
  return { dim: undefined, source: 'unknown' };
}

async function getCollectionStats(name) {
  try {
    const desc = await milvus.describeCollection({ collection_name: name });
    const stats = await milvus.getCollectionStatistics({ collection_name: name });

    let rowCount = 0;
    const rawStats = stats?.stats || stats?.data || stats || [];
    const statArr = Array.isArray(rawStats) ? rawStats : Object.values(rawStats || {});
    for (const s of statArr) {
      if (typeof s?.row_count !== 'undefined') rowCount = Number(s.row_count);
      if (s?.key === 'row_count' && typeof s?.value !== 'undefined') rowCount = Number(s.value);
      if (typeof s === 'object' && s && 'row_count' in s) rowCount = Number(s.row_count);
    }

    const { dim, source } = await safeGetDimFromDB(name, desc);
    const fields = desc?.schema?.fields || [];

    console.log('ℹ️ Collection:', {
      name: desc?.collection_name,
      db: currentDb,
      loaded: desc?.loaded_percentage ?? 'n/a',
      rowCount,
      dim,
      dim_source: source,
      fields: fields.map(f => ({
        name: f.name,
        type: f.data_type,
        dim: kvGet(f?.type_params, 'dim') ?? kvGet(f?.params, 'dim')
      }))
    });

    return { rowCount, dim };
  } catch (e) {
    console.warn('⚠️ getCollectionStats:', e?.message || e);
    return { rowCount: 0, dim: undefined };
  }
}

async function ensureIndexAndLoad(name) {
  try {
    await milvus.createIndex({
      collection_name: name,
      field_name: 'vector',
      index_name: 'auto_cosine',
      index_type: 'AUTOINDEX',
      metric_type: 'COSINE',
      params: {}
    });
  } catch (e) {
    const msg = String(e?.message || e).toLowerCase();
    if (!msg.includes('already exists')) {
      console.warn('⚠️ createIndex warn:', e?.message || e);
    }
  }

  try {
    let tries = 0;
    while (tries < 20) {
      const s = await milvus.describeIndex({ collection_name: name, field_name: 'vector' });
      const state = s?.index_descriptions?.[0]?.state || s?.state;
      if (!state || String(state).toLowerCase() === 'finished') break;
      await new Promise(r => setTimeout(r, 500));
      tries++;
    }
  } catch (e) {
    console.warn('⚠️ describeIndex warn:', e?.message || e);
  }

  try {
    await milvus.loadCollection({ collection_name: name });
    return true;
  } catch (e) {
    console.warn('⚠️ loadCollection warn:', e?.message || e);
    return false;
  }
}

async function ensureCollectionLoaded(name) {
  try {
    const desc = await milvus.describeCollection({ collection_name: name });
    if (!desc?.collection_name) {
      console.warn(`⚠️ Collection "${name}" nicht gefunden (DB=${currentDb}).`);
      return false;
    }
    await milvus.loadCollection({ collection_name: name });
    return true;
  } catch (e) {
    console.warn('⚠️ ensureCollectionLoaded Fehler:', e?.message || e);
    return false;
  }
}

async function embedText(text) {
  const body =
    OLLAMA_EMBED_MODE === 'input'
      ? { model: OLLAMA_EMBED_MODEL, input: text }
      : { model: OLLAMA_EMBED_MODEL, prompt: text };

  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`Ollama /api/embeddings ${r.status}: ${raw.slice(0, 400)}`);

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Embedding JSON ungültig: ${raw.slice(0, 400)}`); }

  const vec = Array.isArray(data.embedding)
    ? data.embedding
    : (Array.isArray(data.embeddings) && Array.isArray(data.embeddings[0])) ? data.embeddings[0] : null;

  if (!Array.isArray(vec) || vec.length === 0) throw new Error(`Leeres Embedding (mode=${OLLAMA_EMBED_MODE}).`);
  return vec;
}

/* ========= Milvus Result Mapping ========= */

function rowsFromMilvusSearch(searchRaw) {
  // iterator v2
  if (Array.isArray(searchRaw?.search_iterator_v2_results) && searchRaw.search_iterator_v2_results.length) {
    return searchRaw.search_iterator_v2_results;
  }
  if (Array.isArray(searchRaw?._search_iterator_v2_results) && searchRaw._search_iterator_v2_results.length) {
    return searchRaw._search_iterator_v2_results;
  }
  // legacy
  if (Array.isArray(searchRaw?.results)) return searchRaw.results;
  if (Array.isArray(searchRaw?.data))    return searchRaw.data;
  return [];
}

function mapMilvusRow(row) {
  const out = {
    score: row?.score ?? row?.distance ?? 0,
    id: row?.id,
    title: row?.title,
    ort: row?.ort,
    pfad: row?.pfad,
    nid: row?.nid,
    ausbildungsberufe: row?.ausbildungsberufe,
    chunk: row?.chunk,
  };

  if (out.title || out.ort || out.chunk) return out;

  if (Array.isArray(row?.fields_data)) {
    for (const fd of row.fields_data) {
      const key = (fd.field_name || fd.name || '').toString();
      const val = fd.value ?? fd.data ?? fd.field ?? (typeof fd.scalar !== 'undefined' ? fd.scalar : undefined);
      if (!key || key === 'vector') continue;
      switch (key) {
        case 'id': out.id = val; break;
        case 'title': out.title = val; break;
        case 'ort': out.ort = val; break;
        case 'pfad': out.pfad = val; break;
        case 'nid': out.nid = val; break;
        case 'chunk': out.chunk = val; break;
        case 'ausbildungsberufe':
          out.ausbildungsberufe = Array.isArray(val) ? val : (typeof val === 'string' ? [val] : []);
          break;
        default: break;
      }
    }
  }
  return out;
}

/* ========= Chunk → Cards Helpers ========= */

function extractFromChunk(h) {
  const chunk = (h?.chunk || '').toString();

  const mName = chunk.match(/^Firma:\s*(.+)$/m);
  const mOrt  = chunk.match(/^Ort:\s*([^\n]+)$/m);
  const mLink = chunk.match(/\(https?:\/\/www\.ausbildungsregion-osnabrueck\.de\/([^)]+)\)/);
  const mBerufe = chunk.match(/^Ausbildungsberufe:\s*([^\n]+)$/m);

  const name = h?.title || (mName ? mName[1].trim() : '');
  const ort  = h?.ort   || (mOrt  ? mOrt[1].trim()  : '');
  let pfad   = h?.pfad  || (mLink ? mLink[1].trim() : '');

  if (!pfad) {
    if (h?.nid) pfad = `node/${h.nid}`;
  }

  let berufe = [];
  if (Array.isArray(h?.ausbildungsberufe) && h.ausbildungsberufe.length) {
    berufe = h.ausbildungsberufe.map(x => String(x || '').trim()).filter(Boolean);
  } else if (mBerufe) {
    berufe = mBerufe[1]
      .split(/,|\s+und\s+/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  return {
    name,
    ort,
    pfad,
    ausbildungsberufe: berufe.slice(0, 2),
  };
}

/* ========= SSE JSON extractor for LLM fallback ========= */

function createJsonStreamExtractor(onJson) {
  let started = false, depth = 0, buf = '';
  return (piece) => {
    for (let i = 0; i < piece.length; i++) {
      const ch = piece[i];
      if (!started) { if (ch === '{') { started = true; depth = 1; buf = '{'; } continue; }
      buf += ch;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonText = buf;
          try { onJson(JSON.parse(jsonText)); }
          catch { onJson(null, jsonText); }
          return true;
        }
      }
    }
    return false;
  };
}

/* ========= Routes ========= */

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    ollama: OLLAMA_URL,
    chatModel: OLLAMA_CHAT_MODEL,
    embedModel: OLLAMA_EMBED_MODEL,
    db: currentDb,
    collection: MILVUS_COLLECTION
  });
});

app.get('/debug/milvus', async (_req, res) => {
  try {
    const list = await milvus.showCollections();
    const names = (list?.data || []).map(c => c.name);
    const stats = await getCollectionStats(MILVUS_COLLECTION);
    res.json({ db: currentDb, collections: names, stats });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/chat', async (req, res) => {
  console.log("📥 /chat Anfrage empfangen:", req.body);
  const timeoutMs = 45000;
  const ac = new AbortController();
  const timer = setTimeout(() => { console.warn('⏱ Timeout %d ms', timeoutMs); ac.abort(); }, timeoutMs);

  try {
    const userMessage = (req.body?.message || '').toString().trim();
    if (!userMessage) {
      clearTimeout(timer);
      return res.status(400).json({ error: 'message fehlt' });
    }

    console.log('📝 Nutzerfrage:', userMessage);

    // 1) Embedding
    console.log('🔹 Starte Embedding-Erzeugung …');
    const vector = await embedText(userMessage);
    console.log(`✅ Embedding erzeugt (Dimension: ${vector.length})`);

    // 2) Sicherstellen: Index/Load + Stats
    await ensureIndexAndLoad(MILVUS_COLLECTION);
    const stats = await getCollectionStats(MILVUS_COLLECTION);
    const rowCount = stats.rowCount;
    const dim = stats.dim;

    if (!dim || dim !== vector.length) {
      console.warn(`⚠️ Schema-Mismatch: vector-dim=${dim} ≠ embed-dim=${vector.length} (DB=${currentDb})`);
    }
    if (rowCount === 0) {
      console.warn('⚠️ RowCount=0 → Collection ist leer (oder anderes Projekt/Token).');
    }

    // 3) Vektor-Suche (nur wenn Daten vorhanden)
    let hits = [];
    if (rowCount > 0) {
      console.log('🔹 Starte Milvus-Suche …');
    
      const rawRows = await milvusSearchRobust({
        collection: MILVUS_COLLECTION,
        vector,
        limit: MILVUS_LIMIT,
        output_fields: ['id','title','ort','nid','pfad','ausbildungsberufe','chunk'],
      });
    
      console.log(`✅ Milvus-Suche abgeschlossen (${rawRows.length} Treffer roh)`);
    
      const mapped = rawRows.map(mapMilvusRow)
        .filter(h => (h.title || h.chunk)); // score kann je nach Form anders heißen
    
      // Score extrahieren/normalisieren
      for (const h of mapped) {
        h.score = Number(h.score ?? h.distance ?? 0);
      }
      console.log('📈 Top-5 Scores:', mapped.slice(0, 5).map(h => Number(h.score).toFixed(4)));
    
      hits = mapped
        .filter(h => Number(h.score) >= Number(MILVUS_MIN_SCORE))
        .sort((a,b) => Number(b.score) - Number(a.score));
    
      console.log(`📊 Gefilterte Treffer (>= ${MILVUS_MIN_SCORE}): ${hits.length}`);
    }
   

    // 4) Feld-Fallback (Ort/Beruf)
    if (hits.length === 0) {
      const m = userMessage.toLowerCase();
      let ort = null;
      const cityList = ['osnabrück','melle','lingen','bad iburg','bissendorf','georgsmarienhütte','bramsche','bad laer','gmhütte','gesmold','hagen a.t.w.'];
      for (const city of cityList) if (m.includes(city)) { ort = city; break; }
      if (!ort) {
        const rx = /\b(?:in|bei|nahe|um)\s+([a-zäöüß\-\.\s]{3,})/i;
        const mm = m.match(rx);
        if (mm) ort = mm[1];
      }
      ort = ort ? ort.replace(/[.,;:!?]+$/g, '').trim() : null;

      const berufRx = /(maler|lackierer|friseur|kfz|elektro|mechatroniker|pflege|bäcker|it|informatik)/i;
      const beruf = (m.match(berufRx) || [])[0] || null;

      console.log('↩️ Fallback: Feldsuche. Heuristik =', { ort, beruf });

      let expr = "id != ''";
      let triedLike = false;
      if (ort) {
        const cap = ort.charAt(0).toUpperCase() + ort.slice(1).toLowerCase();
        expr = `like(ort, "${cap}%")`;
        triedLike = true;
      }

      let rows = [];
      try {
        const q = await milvus.query({
          collection_name: MILVUS_COLLECTION,
          expr,
          limit: Math.min(50, MILVUS_LIMIT * 2),
          output_fields: ['chunk', 'title', 'ort', 'pfad', 'nid', 'ausbildungsberufe'],
          consistency_level: 'Strong',
        });
        rows = Array.isArray(q?.data) ? q.data : [];
      } catch (e) {
        // falls like() nicht unterstützt → Gleichheit probieren
        if (triedLike && ort) {
          const cap = ort.charAt(0).toUpperCase() + ort.slice(1).toLowerCase();
          try {
            const q2 = await milvus.query({
              collection_name: MILVUS_COLLECTION,
              expr: `ort == "${cap}"`,
              limit: Math.min(50, MILVUS_LIMIT * 2),
              output_fields: ['chunk', 'title', 'ort', 'pfad', 'nid', 'ausbildungsberufe'],
              consistency_level: 'Strong',
            });
            rows = Array.isArray(q2?.data) ? q2.data : [];
          } catch (e2) {
            console.warn('⚠️ Feld-Fallback query() fehlgeschlagen:', e2?.message || e2);
          }
        } else {
          console.warn('⚠️ Feld-Fallback query() fehlgeschlagen:', e?.message || e);
        }
      }

      if (beruf) {
        const needle = beruf.toLowerCase();
        rows = rows.filter(r =>
          (Array.isArray(r?.ausbildungsberufe) && r.ausbildungsberufe.some(b => (b||'').toLowerCase().includes(needle)))
          || (r?.chunk || '').toLowerCase().includes(needle)
        );
      }
      hits = rows.slice(0, MILVUS_LIMIT).map(r => ({ score: 0.0, ...r }));
      console.log(`↩️ Feld-Fallback lieferte ${hits.length} Einträge (vor Limit=${MILVUS_LIMIT}).`);
    }

    // 5) Wenn Treffer vorhanden → sofort JSON an Client (ohne LLM)
    if (hits.length > 0) {
      const items = hits.slice(0, MILVUS_LIMIT).map(extractFromChunk).filter(it => it.name && it.ort && it.pfad);
      const payload = { items, includeBerufeLink: true };

      // SSE Antwort
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      clearTimeout(timer);
      console.log(`📤 Antwort an Client gesendet (direkt, ${items.length} Cards)`);
      return;
    }

    // 6) LLM-Fallback (kontextarm) → JSON-only
    const topChunks = hits.map(h => h.chunk).filter(Boolean);
    const context = topChunks.join('\n\n');

    const jsonSchemaInstruction = `
Du bist ein JSON-Generator. Gib EXAKT EIN gültiges JSON-Objekt zurück und sonst NICHTS.
SCHEMA:
{
  "items": [
    { "name": string, "ort": string, "pfad": string, "ausbildungsberufe": string[] }
  ],
  "includeBerufeLink": boolean
}
REGELN:
- Kein Markdown, keine Erklärungen, NUR das JSON-Objekt.
- "ausbildungsberufe" max. 2 Einträge.
- Wenn im KONTEXT nichts Nützliches ist, gib {"items": [], "includeBerufeLink": true}.
    `.trim();

    const finalPrompt =
      `${BASE_PROMPT}\n\n${jsonSchemaInstruction}\n\nKONTEXT:\n${context}\n\nFRAGE:\n${userMessage}\n`;

    // SSE Start
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    console.log('🛠 Erzeuge Final-Prompt für Modell:', OLLAMA_CHAT_MODEL);
    console.log('🚀 Sende Anfrage an Ollama:', OLLAMA_URL);

    const llmResp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_CHAT_MODEL, prompt: finalPrompt, stream: true, options: { temperature: 0.1, top_p: 0.9 } }),
      signal: ac.signal
    });

    if (!llmResp.ok || !llmResp.body) {
      console.error(`❌ Ollama-Fehler: Status ${llmResp.status}`);
      res.write(`data: ${JSON.stringify({ items: [], includeBerufeLink: true, error: 'Ollama-Fehler', status: llmResp.status })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      clearTimeout(timer);
      return;
    }

    let sent = false;
    const decoder = new TextDecoder('utf-8');
    const emitOnce = (obj, raw) => {
      if (sent) return true;
      const payload = obj ?? { items: [], includeBerufeLink: true, _raw: (raw || '').slice(0, 2000) };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      sent = true;
      clearTimeout(timer);
      console.log('📤 Antwort an Client gesendet (LLM-Fallback)');
      return true;
    };
    const takeJson = createJsonStreamExtractor((parsed, rawText) => emitOnce(parsed, rawText));

    console.log('📡 Beginne LLM-Streaming …');
    for await (const chunk of llmResp.body) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.trim() === '[DONE]') continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg?.response === 'string' && msg.response) {
            const finished = takeJson(msg.response);
            if (finished) break;
          } else if (msg?.done && !sent) {
            emitOnce(null, '');
          }
        } catch { /* ignore */ }
      }
      if (sent) break;
    }
    if (!sent) emitOnce(null, '');
  } catch (error) {
    clearTimeout(timer);
    console.error('❌ Fehler /chat:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Interner Serverfehler', detail: String(error?.message || error) });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ items: [], includeBerufeLink: true, error: 'Interner Serverfehler' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {}
    }
  }
});

app.post('/feedback', async (_req, res) => res.status(200).json({ message: 'Feedback erhalten' }));

const PORT = process.env.PORT || 5544;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));