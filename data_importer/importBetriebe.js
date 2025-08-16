// importBetriebe.js
// JSON:API → Chunk → Ollama Embeddings → Milvus/Zilliz (Serverless)
// .env: ZILLIZ_URI, ZILLIZ_TOKEN, MILVUS_COLLECTION, OLLAMA_URL, OLLAMA_MODEL=bge-m3, AUSBILDUNGSREGION_BASE

import fetch from "node-fetch";
import fs from "fs";
import dotenv from "dotenv";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";

dotenv.config();

/* =============== CONFIG =============== */

const BASE_URL =
  "https://www.ausbildungsregion-osnabrueck.de/jsonapi/node/betrieb";
const INCLUDE =
  "uid,field_ausbildungsberufe,field_ausbildungsberufe.field_berufsbereich,field_betriebsart";
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 50);

const ZILLIZ_URI = process.env.ZILLIZ_URI;
const ZILLIZ_TOKEN = process.env.ZILLIZ_TOKEN;
const MILVUS_COLLECTION = process.env.MILVUS_COLLECTION;

// Basis-Domain der Website für Node-Links (kann per .env überschrieben werden)
const SITE_BASE = (process.env.AUSBILDUNGSREGION_BASE ||
  "https://www.ausbildungsregion-osnabrueck.de").replace(/\/+$/, "");

const PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "ollama").toLowerCase();
const OLLAMA_BASE = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "bge-m3";

// Für bge-* default auf prompt, sonst auto (überschreibbar)
const defaultMode = /(^|\W)bge/.test((OLLAMA_MODEL || "").toLowerCase()) ? "prompt" : "auto";
const OLLAMA_EMBED_MODE = (process.env.OLLAMA_EMBED_MODE || defaultMode).toLowerCase(); // auto|input|prompt

let EMBED_BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE || 32);
const EMBED_MIN_BATCH = 1;
const EMBED_MAX_RETRIES = 2; // pro Batch
const ITEM_RETRY_DELAY_MS = 250;

const DEBUG_VERBOSE = String(process.env.DEBUG_VERBOSE || "") === "1";
const SKIP_DELETE = String(process.env.SKIP_DELETE || "") === "1";
const VERIFY_SAMPLE = Number(process.env.VERIFY_SAMPLE || 3);
const AUTO_RECREATE_COLLECTION = String(process.env.AUTO_RECREATE_COLLECTION || "") === "1";

function assertEnv(name, value) {
  if (!value) {
	console.error(`❌ ENV ${name} fehlt. Bitte in .env setzen.`);
	process.exit(1);
  }
}
assertEnv("ZILLIZ_URI", ZILLIZ_URI);
assertEnv("ZILLIZ_TOKEN", ZILLIZ_TOKEN);
assertEnv("MILVUS_COLLECTION", MILVUS_COLLECTION);

// Modell→Dim Heuristik
function inferDimByModel(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("bge-m3")) return 1024;
  if (m.includes("all-minilm")) return 384;
  if (m.includes("nomic-embed-text")) return 768;
  return null;
}
const VECTOR_DIM =
  Number(process.env.OLLAMA_MODEL_DIM || "") || inferDimByModel(OLLAMA_MODEL);
if (!VECTOR_DIM) {
  console.error(
	`❌ Dim kann nicht aus Modell abgeleitet werden: "${OLLAMA_MODEL}". Setze OLLAMA_MODEL_DIM in .env!`
  );
  process.exit(1);
}

console.log("═".repeat(72));
console.log("🚀 Start: Import Betriebe → Milvus/Zilliz");
console.log("— CONFIG —");
console.log(`  BASE_URL         : ${BASE_URL}`);
console.log(`  INCLUDE          : ${INCLUDE}`);
console.log(`  PAGE_LIMIT       : ${PAGE_LIMIT}`);
console.log(`  ZILLIZ_URI       : ${ZILLIZ_URI}`);
console.log(`  ZILLIZ_TOKEN     : ${ZILLIZ_TOKEN ? "********" : "(leer)"}`);
console.log(`  MILVUS_COLLECTION: ${MILVUS_COLLECTION}`);
console.log(`  SITE_BASE        : ${SITE_BASE}`);
console.log(`  EMBEDDINGS       : provider=${PROVIDER}, base=${OLLAMA_BASE}, model=${OLLAMA_MODEL}`);
console.log(`  OLLAMA_EMBED_MODE: ${OLLAMA_EMBED_MODE} (default=${defaultMode})`);
console.log(`  VECTOR_DIM       : ${VECTOR_DIM}`);
console.log(`  EMBED_BATCH_SIZE : ${EMBED_BATCH_SIZE}`);
console.log(`  DEBUG_VERBOSE    : ${DEBUG_VERBOSE}`);
console.log(`  SKIP_DELETE      : ${SKIP_DELETE}`);
console.log(`  AUTO_RECREATE_COLL: ${AUTO_RECREATE_COLLECTION}`);
console.log("═".repeat(72));

/* =============== MILVUS CLIENT =============== */

const milvus = new MilvusClient({ address: ZILLIZ_URI, token: ZILLIZ_TOKEN });

function unwrapMilvusError(e) {
  const parts = [];
  if (e?.message) parts.push(e.message);
  if (e?.reason) parts.push(`Reason: ${e.reason}`);
  if (e?.error_code) parts.push(`ErrorCode: ${e.error_code}`);
  const js = JSON.stringify(e, null, 2);
  if (js && js.length < 2000) parts.push(js);
  return parts.join(" | ");
}

async function describeOrNull(name) {
  try {
	return await milvus.describeCollection({ collection_name: name });
  } catch {
	return null;
  }
}

function typeParamDim(field) {
  // dim kann je nach SDK unter type_params.dim, type_params.DIM, oder direkt als .dim hängen
  const dim =
	field?.dim ??
	field?.type_params?.dim ??
	field?.type_params?.DIM ??
	field?.params?.dim ??
	field?.params?.DIM;
  return dim !== undefined ? Number(dim) : undefined;
}

function fieldByName(info, name) {
  return info?.schema?.fields?.find((f) => f.name === name);
}

// gewünschtes Zielschema
const TARGET_SCHEMA = {
  vectorDim: VECTOR_DIM,
  fields: [
	{ name: "id",                type: "VarChar",     opts: { max_length: 36,  is_primary_key: true, autoID: false } },
	{ name: "vector",            type: "FloatVector", opts: { dim: VECTOR_DIM } },
	{ name: "nid",               type: "Int64" },
	{ name: "title",             type: "VarChar",     opts: { max_length: 255 } },
	{ name: "ort",               type: "VarChar",     opts: { max_length: 100 } },
	{ name: "mitarbeiter",       type: "Int64" },
	{ name: "auszubildende",     type: "Int64" },
	{ name: "berufsbereiche",    type: "VarChar",     opts: { max_length: 1024 } },
	{ name: "ansprechpartner",   type: "VarChar",     opts: { max_length: 255 } },
	{ name: "chunk",             type: "VarChar",     opts: { max_length: 8192 } },
	{ name: "ausbildungsberufe", type: "VarChar",     opts: { max_length: 1024 } },
  ],
  enable_dynamic_field: false,
};

function schemaMismatch(info) {
  if (!info) return true;
  const fields = info?.schema?.fields || [];
  const needed = new Map(TARGET_SCHEMA.fields.map(f => [f.name, f]));
  for (const f of needed.values()) {
	const got = fields.find(x => x.name === f.name);
	if (!got) return `Feld fehlt: ${f.name}`;
	if (!String(got.data_type || got.type).toLowerCase().includes(f.type.toLowerCase())) {
	  return `Feldtyp abweichend: ${f.name}`;
	}
	if (f.name === "vector") {
	  const dim = typeParamDim(got);
	  if (dim !== TARGET_SCHEMA.vectorDim) return `Vector-Dim abweichend: ${dim} ≠ ${TARGET_SCHEMA.vectorDim}`;
	}
	if (f.type === "VarChar" && f?.opts?.max_length) {
	  const ml = got?.max_length ?? got?.type_params?.max_length ?? got?.params?.max_length;
	  if (ml && Number(ml) < f.opts.max_length) return `max_length zu klein für ${f.name}: ${ml} < ${f.opts.max_length}`;
	}
	if (f.name === "id" && !(got.is_primary_key || got.is_primary)) return "id ist nicht Primary Key";
  }
  const dyn = !!info?.schema?.enable_dynamic_field;
  if (dyn !== TARGET_SCHEMA.enable_dynamic_field) return `enable_dynamic_field abweichend: ${dyn} ≠ ${TARGET_SCHEMA.enable_dynamic_field}`;
  return false;
}

async function dropCollectionIfExists(name) {
  try {
	await milvus.dropCollection({ collection_name: name });
	console.log(`  🗑 Collection "${name}" gelöscht (Recreate).`);
	await new Promise((r) => setTimeout(r, 500));
  } catch (e) {
	console.log(`  ⚠️ Drop-Hinweis: ${unwrapMilvusError(e)}`);
  }
}

async function createTargetCollection() {
  console.log(`🆕 Erzeuge Collection "${MILVUS_COLLECTION}" (dim=${TARGET_SCHEMA.vectorDim}) …`);
  await milvus.createCollection({
	collection_name: MILVUS_COLLECTION,
	fields: TARGET_SCHEMA.fields.map((f) => {
	  const base = { name: f.name };
	  if (f.type === "VarChar") base.data_type = "VarChar";
	  else if (f.type === "FloatVector") base.data_type = "FloatVector";
	  else if (f.type === "Int64") base.data_type = "Int64";
	  if (f.opts?.max_length) base.max_length = f.opts.max_length;
	  if (f.opts?.dim) base.dim = f.opts.dim;
	  if (f.opts?.is_primary_key !== undefined) base.is_primary_key = f.opts.is_primary_key;
	  if (f.opts?.autoID !== undefined) base.autoID = f.opts.autoID;
	  return base;
	}),
	enable_dynamic_field: TARGET_SCHEMA.enable_dynamic_field,
  });
  console.log("  ✅ Collection erstellt");
}

async function ensureCollectionAndIndex() {
  let info = await describeOrNull(MILVUS_COLLECTION);
  const mismatch = schemaMismatch(info);
  if (mismatch) {
	console.log(`⚠️ Schema-Mismatch: ${mismatch}`);
	if (!AUTO_RECREATE_COLLECTION && info) {
	  console.log("   → Setze AUTO_RECREATE_COLLECTION=1 in .env ODER Collection manuell löschen.");
	  process.exit(1);
	}
	if (info) await dropCollectionIfExists(MILVUS_COLLECTION);
	await createTargetCollection();
	info = await describeOrNull(MILVUS_COLLECTION);
  } else {
	console.log("ℹ️ Collection-Schema OK.");
  }

  try {
	console.log("🔧 Erzeuge/prüfe Index auf 'vector' (AUTOINDEX, COSINE) …");
	await milvus.createIndex({
	  collection_name: MILVUS_COLLECTION,
	  field_name: "vector",
	  index_type: "AUTOINDEX",
	  metric_type: "COSINE",
	  params: {},
	});
	console.log("  ✅ Index ok");
  } catch (e) {
	console.log(`  ⚠️ Index-Hinweis: ${unwrapMilvusError(e)}`);
  }

  try {
	await milvus.loadCollection({ collection_name: MILVUS_COLLECTION });
	console.log("📥 Collection geladen");
  } catch (e) {
	console.log(`  ⚠️ Load-Hinweis: ${unwrapMilvusError(e)}`);
  }
}

/* =============== FETCH JSON:API =============== */

async function fetchJSON(url, label = "GET") {
  const res = await fetch(url, { headers: { Accept: "application/vnd.api+json" } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${label} ${res.status} ${res.statusText} :: ${url}\n${txt}`);
  try { return JSON.parse(txt); }
  catch { throw new Error(`Ungültiges JSON von ${label} :: ${url}\n${txt.slice(0, 300)}…`); }
}
const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

async function fetchAllBetriebe() {
  console.log("🔄 Lade Betriebe aus JSON:API …");
  let all = [];
  let url = `${BASE_URL}?include=${INCLUDE}&page[limit]=${PAGE_LIMIT}`;
  let page = 1;

  while (url) {
	const json = await fetchJSON(url, "GET");
	const items = json?.data || [];
	console.log(`  📄 Seite ${String(page).padStart(2, "0")}: +${items.length} Einträge`);

	if (DEBUG_VERBOSE && page === 1 && items.length) {
	  const sample = first(items);
	  try {
		fs.writeFileSync("debug_first_item.json", JSON.stringify(sample, null, 2), "utf8");
		console.log("  🧪 debug_first_item.json geschrieben (erste Ressource Seite 1)");
	  } catch (e) {
		console.log("  ⚠️ Konnte debug_first_item.json nicht schreiben:", e.message);
	  }
	  const topKeys = Object.keys(sample || {});
	  const attrKeys = Object.keys(sample?.attributes || {});
	  console.log(`  🧩 Sample Keys: top=[${topKeys.join(", ")}], attributes=[${attrKeys.join(", ")}]`);
	}

	all = all.concat(items);
	url = json?.links?.next?.href || null;
	page++;
  }

  console.log(`📦 ${all.length} Betriebe geladen`);
  return all;
}

/* =============== MAPPING / LIST NORMALISER =============== */

function hasClassicAttributes(node) {
  return node && typeof node === "object" && node.attributes && typeof node.attributes === "object";
}
function hasFlatShape(node) {
  return node && typeof node === "object" && ("title" in node || "drupal_internal__nid" in node);
}
function pick(node, key, fallback = undefined) {
  if (!node || typeof node !== "object") return fallback;
  if (hasClassicAttributes(node)) {
	const vAttr = node.attributes?.[key];
	if (vAttr !== undefined && vAttr !== null) return vAttr;
  }
  const vTop = node?.[key];
  return vTop !== undefined && vTop !== null ? vTop : fallback;
}

function toWebsiteString(field_website) {
  if (!field_website) return "";
  if (typeof field_website === "string") return field_website;
  if (typeof field_website === "object" && field_website.uri) return field_website.uri;
  return "";
}
function toOrt(node) {
  const adresse = pick(node, "field_adresse", null);
  if (adresse && typeof adresse === "object" && adresse.locality) return adresse.locality;
  const ort = pick(node, "field_ort", "");
  return ort || "";
}

/** Absolute Node-URL ermitteln (bevorzugt path.alias, sonst /node/<nid>) */
function toNodeUrl(node) {
  const nid = Number(pick(node, "drupal_internal__nid", null));
  const p = pick(node, "path", null);
  let alias = null;
  if (typeof p === "string") alias = p;
  else if (p && typeof p === "object") alias = p.alias || p.url || p.uri || null;

  if (alias) {
	return /^https?:\/\//.test(alias)
	  ? alias
	  : SITE_BASE + (alias.startsWith("/") ? alias : `/${alias}`);
  }
  if (nid) return `${SITE_BASE}/node/${nid}`;
  return null;
}

/** Robust: holt ein lesbares Label aus beliebigen Strukturen */
function labelOf(x) {
  if (x == null) return null;
  if (typeof x === "string") return x.trim() || null;
  if (typeof x === "number") return String(x);
  if (Array.isArray(x)) {
	const out = x.map(labelOf).filter(Boolean);
	return out.length ? out.join(", ") : null;
  }
  if (typeof x === "object") {
	const cand = x.name ?? x.title ?? x.label ?? x.value ?? x.text ?? x.term ?? x.bundle;
	if (cand && typeof cand === "string") return cand.trim() || null;
	const cand2 =
	  x.attributes?.name ?? x.attributes?.title ?? x.attributes?.label ?? x.attributes?.value;
	if (cand2 && typeof cand2 === "string") return cand2.trim() || null;
  }
  return null;
}

/** Nimmt Strings/Objekte/Arrays und gibt Array<string> mit Labels zurück */
function toLabelArray(val) {
  if (val == null) return [];
  if (typeof val === "string") return [val.trim()].filter(Boolean);
  if (Array.isArray(val)) {
	return val.map(labelOf).filter(Boolean);
  }
  if (typeof val === "object") {
	const l = labelOf(val);
	return l ? [l] : [];
  }
  return [];
}

/** Holt ggf. verschachtelte Felder (z.B. field_ausbildungsberufe[].field_berufsbereich) */
function pluckNestedList(val, nestedKey) {
  if (!val) return [];
  const arr = Array.isArray(val) ? val : [val];
  const out = [];
  for (const item of arr) {
	const sub = (item && typeof item === "object") ? item[nestedKey] ?? item?.attributes?.[nestedKey] : null;
	if (sub == null) continue;
	out.push(...toLabelArray(sub));
  }
  return out;
}

/** Dedupliziert + schneidet auf Länge zu */
function uniqJoin(list, maxLen = 1024) {
  const s = [...new Set(list.map(x => (x || "").trim()).filter(Boolean))].join(", ");
  return s.length > maxLen ? s.slice(0, maxLen - 1) : s;
}

function extractStructured(betrieb, index) {
  const classic = hasClassicAttributes(betrieb);
  const flat = hasFlatShape(betrieb);
  if (!classic && !flat) return null;

  const id = String(betrieb.id || "").trim();
  const nid = Number(pick(betrieb, "drupal_internal__nid", 0)) || null;
  const title = pick(betrieb, "title", "Unbenannt");
  const ort = toOrt(betrieb) || "Ort unbekannt";
  const mitarbeiter = Number(pick(betrieb, "field_mitarbeiter", null));
  const auszubildende = Number(pick(betrieb, "field_auszubildende", null));
  const ansprechpartner = labelOf(pick(betrieb, "field_ansprechpartner", "")) || "";

  // ausbildungsberufe + berufsbereiche
  const ausbVal = pick(betrieb, "field_ausbildungsberufe", null);
  const ausbildungsberufeArr = toLabelArray(ausbVal);
  const berufsbereicheArr = pluckNestedList(ausbVal, "field_berufsbereich");
  const fallbackBB = toLabelArray(pick(betrieb, "field_berufe_im_betrieb", null));
  const berufsbereiche = uniqJoin(berufsbereicheArr.length ? berufsbereicheArr : fallbackBB);
  const ausbildungsberufe = uniqJoin(ausbildungsberufeArr);

  const telefon = labelOf(pick(betrieb, "field_telefon", "")) || "";
  const email =
	labelOf(pick(betrieb, "field_email_ansprechpartner", null)) ||
	labelOf(pick(betrieb, "field_email", null)) ||
	"";
  const website = toWebsiteString(pick(betrieb, "field_website", ""));
  const nodeUrl = toNodeUrl(betrieb);

  let chunk =
	`Firma: ${title}\n` +
	`Ort: ${ort}\n` +
	`Mitarbeiter: ${Number.isFinite(mitarbeiter) ? mitarbeiter : "n.a."}, Auszubildende: ${Number.isFinite(auszubildende) ? auszubildende : "n.a."}\n` +
	(telefon ? `Telefon: ${telefon}\n` : "") +
	(email ? `E-Mail: ${email}\n` : "") +
	(website ? `Website: ${website}\n` : "") +
	(ansprechpartner ? `Ansprechpartner: ${ansprechpartner}\n` : "") +
	(berufsbereiche ? `Berufsbereiche: ${berufsbereiche}\n` : "") +
	(ausbildungsberufe ? `Ausbildungsberufe: ${ausbildungsberufe}\n` : "");
  // ➕ Call-to-Action mit Link zur Node
  if (nodeUrl) {
	chunk += `[Jetzt Praktikum oder Ausbildung online anfragen!](${nodeUrl})\n`;
  }

  if (DEBUG_VERBOSE && index < 5) {
	console.log(
	  `  🧩 Mapping @${index} (${id}) [${classic ? "attributes" : "flat"}]: title="${title}", ort="${ort}"`
	);
  }

  return {
	id,
	nid,
	title,
	ort,
	mitarbeiter: Number.isFinite(mitarbeiter) ? mitarbeiter : null,
	auszubildende: Number.isFinite(auszubildende) ? auszubildende : null,
	berufsbereiche,
	ansprechpartner,
	ausbildungsberufe,
	chunk,
  };
}

/* =============== OLLAMA EMBEDDINGS =============== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkEmbeddings() {
  if (PROVIDER !== "ollama")
	return { ok: false, info: `Unbekannter Provider: ${PROVIDER}` };
  try {
	const r = await fetch(`${OLLAMA_BASE}/api/version`);
	const t = await r.text();
	return r.ok ? { ok: true, info: t.trim() } : { ok: false, info: `HTTP ${r.status}: ${t}` };
  } catch (e) {
	return { ok: false, info: String(e) };
  }
}

let detectedEmbedMode = null; // "input" | "prompt"

async function embedWithInput(texts) {
  const url = `${OLLAMA_BASE}/api/embeddings`;
  const body = { model: OLLAMA_MODEL, input: texts };
  if (DEBUG_VERBOSE)
	console.log(`  🌐 POST ${url} (model="${OLLAMA_MODEL}", batch=${texts.length}, mode=input)`);
  const res = await fetch(url, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} /api/embeddings (mode=input) — ${raw || "(leer)"}`);

  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`Ungültiges JSON (mode=input): ${raw.slice(0, 200)}…`); }

  const vectors = Array.isArray(data.embeddings)
	? data.embeddings
	: data.embedding
	? [data.embedding]
	: [];

  if (!vectors.length || !Array.isArray(vectors[0]) || vectors[0].length === 0) {
	throw new Error(`Embedding leer (mode=input).`);
  }
  if (vectors[0].length !== VECTOR_DIM) {
	throw new Error(`Dim-Mismatch (mode=input): got=${vectors[0].length}, expected=${VECTOR_DIM}`);
  }
  return vectors;
}

async function embedWithPrompt(texts) {
  const url = `${OLLAMA_BASE}/api/embeddings`;
  const out = [];
  for (let i = 0; i < texts.length; i++) {
	const body = { model: OLLAMA_MODEL, prompt: texts[i] };
	if (DEBUG_VERBOSE)
	  console.log(`  🌐 POST ${url} (model="${OLLAMA_MODEL}", item=${i + 1}/${texts.length}, mode=prompt)`);
	let res = await fetch(url, {
	  method: "POST",
	  headers: { "Content-Type": "application/json" },
	  body: JSON.stringify(body),
	});
	let raw = await res.text();
	if (!res.ok || !raw) {
	  await sleep(ITEM_RETRY_DELAY_MS);
	  res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	  });
	  raw = await res.text();
	  if (!res.ok) throw new Error(`HTTP ${res.status} /api/embeddings (mode=prompt) — ${raw || "(leer)"}`);
	}
	let data;
	try { data = JSON.parse(raw); }
	catch { throw new Error(`Ungültiges JSON (mode=prompt): ${raw.slice(0, 200)}…`); }
	const vec = data.embedding || (Array.isArray(data.embeddings) ? data.embeddings[0] : null);
	if (!Array.isArray(vec) || vec.length === 0) throw new Error(`Embedding leer (mode=prompt, item ${i + 1}).`);
	if (vec.length !== VECTOR_DIM) throw new Error(`Dim-Mismatch (mode=prompt, item ${i + 1}): got=${vec.length}, expected=${VECTOR_DIM}`);
	out.push(vec);
  }
  return out;
}

async function detectMode() {
  if (OLLAMA_EMBED_MODE !== "auto") {
	detectedEmbedMode = OLLAMA_EMBED_MODE;
	console.log(`🔧 Embed-Mode fest vorgegeben: ${detectedEmbedMode}`);
	return;
  }
  try {
	const v = await embedWithInput(["probe"]);
	detectedEmbedMode = "input";
	console.log(`🔧 Embed-Mode erkannt: input (dim=${v[0].length})`);
	return;
  } catch (e) {
	console.log(`  ↪️ input-Probe gescheitert: ${e.message || e}`);
  }
  const v2 = await embedWithPrompt(["probe"]);
  detectedEmbedMode = "prompt";
  console.log(`🔧 Embed-Mode erkannt: prompt (dim=${v2[0].length})`);
}

async function embedBatch(texts) {
  const mode = detectedEmbedMode || (OLLAMA_EMBED_MODE === "auto" ? "input" : OLLAMA_EMBED_MODE);
  return mode === "input" ? embedWithInput(texts) : embedWithPrompt(texts);
}

/* =============== MILVUS OPS =============== */

async function getRowCount() {
  try {
	const s = await milvus.getCollectionStatistics({ collection_name: MILVUS_COLLECTION });
	const cnt = Number(s?.stats?.row_count || s?.row_count || 0);
	return cnt;
  } catch (e) {
	console.log(`  ⚠️ Stats-Hinweis: ${unwrapMilvusError(e)}`);
	return NaN;
  }
}

async function showSample(limit = 3) {
  try {
	const res = await milvus.query({
	  collection_name: MILVUS_COLLECTION,
	  expr: 'id != ""',
	  output_fields: ["id", "title", "ort", "berufsbereiche", "ausbildungsberufe", "chunk"],
	  limit,
	});
	const rows = Array.isArray(res?.data) ? res.data : [];
	console.log(`🔎 Sample (${rows.length}/${limit}):`);
	rows.forEach((r, i) => {
	  const preview = (r.chunk || "").replace(/\s+/g, " ").slice(0, 140);
	  console.log(`   #${i + 1} id=${r.id} title="${r.title}" ort="${r.ort}" :: berufs="${r.berufsbereiche}" :: ausb="${r.ausbildungsberufe}" :: "${preview}…"`);
	});
  } catch (e) {
	console.log(`  ⚠️ Query-Hinweis: ${unwrapMilvusError(e)}`);
  }
}

async function deleteAllInCollection() {
  console.log(`🧹 Lösche alte Daten aus Milvus (${MILVUS_COLLECTION})`);
  try {
	await milvus.deleteEntities({
	  collection_name: MILVUS_COLLECTION,
	  expr: 'id != ""',
	});
	await milvus.flush({ collection_names: [MILVUS_COLLECTION] });
	console.log("  ✅ Delete ok");
  } catch (e) {
	console.log(`  ⚠️ Delete-Hinweis: ${unwrapMilvusError(e)}`);
  }
}

async function insertRows(rows, attemptCtx = "") {
  try {
	const res = await milvus.insert({
	  collection_name: MILVUS_COLLECTION,
	  fields_data: rows,
	});
	await milvus.flush({ collection_names: [MILVUS_COLLECTION] });
	return res;
  } catch (e) {
	const msg = unwrapMilvusError(e);
	throw new Error(`${attemptCtx}${msg}`);
  }
}

/* =============== PIPELINE =============== */

async function updateMilvus(structs) {
  console.log("➕ Erzeuge Embeddings (Ollama) und füge neue Einträge ein …");

  const hc = await checkEmbeddings();
  console.log(`  🔎 Embedding-Healthcheck: ${hc.ok ? "OK" : "FEHLER"} — ${hc.info}`);
  if (!hc.ok) throw new Error(`Embedding-Backend nicht erreichbar: ${hc.info}`);

  await detectMode();

  let ok = 0, fail = 0, inserted = 0;
  let batchSize = EMBED_BATCH_SIZE;

  for (let start = 0; start < structs.length; ) {
	const end = Math.min(start + batchSize, structs.length);
	const slice = structs.slice(start, end);
	const texts = slice.map(s => s.chunk);

	let attempt = 0;
	let done = false;
	while (attempt <= EMBED_MAX_RETRIES && !done) {
	  try {
		const vectors = await embedBatch(texts);
		const n = Math.min(slice.length, vectors.length);

		const rows = [];
		for (let i = 0; i < n; i++) {
		  const s = slice[i];
		  rows.push({
			id: s.id,
			nid: s.nid,
			title: s.title,
			ort: s.ort,
			mitarbeiter: s.mitarbeiter,
			auszubildende: s.auszubildende,
			berufsbereiche: s.berufsbereiche,
			ansprechpartner: s.ansprechpartner,
			chunk: s.chunk,
			ausbildungsberufe: s.ausbildungsberufe,
			vector: vectors[i],
		  });
		}

		const ctx = `Insert @${start}-${end} (size=${batchSize}) → `;
		await insertRows(rows, ctx);

		ok += rows.length;
		inserted += rows.length;
		console.log(
		  `  ✅ Batch ${Math.floor(start / batchSize) + 1} (mode=${detectedEmbedMode} size=${batchSize}): inserted ${rows.length}`
		);
		done = true;
	  } catch (e) {
		attempt++;
		const msg = e?.message || String(e);
		console.error(
		  `  ❌ Batch @${start}-${end} (size=${batchSize}) fehlgeschlagen [try ${attempt}/${EMBED_MAX_RETRIES}]: ${msg}`
		);
		if (/Dim-Mismatch|Ungültiges JSON/.test(msg)) throw e;
		if (attempt <= EMBED_MAX_RETRIES) await sleep(300);
	  }
	}

	if (!done) {
	  if (batchSize > EMBED_MIN_BATCH) {
		batchSize = Math.max(EMBED_MIN_BATCH, Math.floor(batchSize / 2));
		console.log(`  ↪️ Verkleinere Batch-Größe auf ${batchSize} und versuche neu.`);
		continue;
	  } else {
		fail += slice.length;
		console.log(`  ⚠️ Überspringe ${slice.length} Items wegen wiederholter Fehler.`);
		start = end;
	  }
	} else {
	  start = end;
	}
  }

  console.log("— EMBED STATS —");
  console.log(`  requested : ${structs.length}`);
  console.log(`  success   : ${ok}`);
  console.log(`  failed    : ${fail}`);
  console.log(`  toInsert  : ${inserted}`);

  if (inserted === 0) {
	console.log("⚠️ Keine gültigen Embeddings → kein Insert.");
	return { inserted: 0 };
  }

  console.log(`✅ Milvus (${MILVUS_COLLECTION}) aktualisiert mit ${inserted} Chunks`);
  return { inserted };
}

/* =============== MAIN =============== */

(async () => {
  const t0 = Date.now();
  try {
	const betriebe = await fetchAllBetriebe();

	let valid = 0, skipped = 0;
	const structs = betriebe
	  .map((b, i) => {
		const s = extractStructured(b, i);
		if (s) valid++; else skipped++;
		return s;
	  })
	  .filter(Boolean);

	console.log("— CHUNK STATS —");
	console.log(`  loaded_total              : ${betriebe.length}`);
	console.log(`  valid_structs             : ${valid}`);
	console.log(`  skipped_without_attributes: ${skipped}`);

	if (valid === 0) {
	  console.log("⚠️ 0 valide Datensätze → Abbruch. Siehe debug_first_item.json / Mapping.");
	  console.log("═".repeat(72));
	  process.exit(1);
	}

	await ensureCollectionAndIndex();

	if (!SKIP_DELETE) {
	  await deleteAllInCollection();
	  const afterDelete = await getRowCount();
	  console.log(`  ℹ️ RowCount nach Delete: ${isNaN(afterDelete) ? "(n/a)" : afterDelete}`);
	} else {
	  console.log("  ⏭️ Delete übersprungen (SKIP_DELETE=1).");
	}

	const { inserted = 0 } = await updateMilvus(structs);

	const rc = await getRowCount();
	console.log(`📈 RowCount nach Insert: ${isNaN(rc) ? "(n/a)" : rc}`);
	await showSample(VERIFY_SAMPLE);

	console.log("— SUMMARY —");
	console.log(`  inserted_rows : ${inserted}`);
	console.log(`  duration_sec  : ${((Date.now() - t0) / 1000).toFixed(1)}`);
	console.log("═".repeat(72));
  } catch (err) {
	console.error("❌ Fehler beim Import:", err?.stack || err);
	console.log("═".repeat(72));
	process.exit(1);
  }
})();