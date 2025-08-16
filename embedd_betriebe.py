# -*- coding: utf-8 -*-
"""
Betriebe -> Milvus/Zilliz RAG Import (idempotent + inkrementell)

- deterministische IDs (sha256(nid + normalized_chunk))
- delete-before-insert pro nid (ersetzt vorhandene Chunks)
- optionaler inkrementeller Lauf (--incremental) via Drupal 'changed'
- erweitertes Schema mit Scalar-Feldern (nid, title, ort, ...)

Env (.env):
  OPENAI_API_KEY=...
  OPENAI_MODEL=text-embedding-3-small
  ZILLIZ_URI=...
  ZILLIZ_TOKEN=...
  MILVUS_COLLECTION=betriebe_chunks
  DRUPAL_API_BASE=https://www.ausbildungsregion-osnabrueck.de/jsonapi/node/betrieb
  PAGE_LIMIT=50
"""

import os
import re
import json
import time
import hmac
import hashlib
import argparse
from datetime import datetime, timezone
from typing import List, Dict, Tuple, Optional

import requests
from requests.adapters import HTTPAdapter, Retry

from pymilvus import (
	connections, FieldSchema, CollectionSchema, DataType,
	Collection, utility
)

# ==== Konfiguration aus ENV ===================================================

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "text-embedding-3-small")

ZILLIZ_URI = os.getenv("ZILLIZ_URI", "")
ZILLIZ_TOKEN = os.getenv("ZILLIZ_TOKEN", "")
COLLECTION_NAME = os.getenv("MILVUS_COLLECTION", "betriebe_chunks")

BASE_URL = os.getenv("DRUPAL_API_BASE", "https://www.ausbildungsregion-osnabrueck.de/jsonapi/node/betrieb")
INCLUDE = (
	"uid,"
	"field_ausbildungsberufe,"
	"field_ausbildungsberufe.field_berufsbereich,"
	"field_betriebsart"
)
PAGE_LIMIT = int(os.getenv("PAGE_LIMIT", "50"))

STATE_FILE = os.getenv("STATE_FILE", "state.json")

# ==== HTTP Session mit Retries ===============================================

def make_session() -> requests.Session:
	s = requests.Session()
	retries = Retry(
		total=5, backoff_factor=0.5,
		status_forcelist=[429, 500, 502, 503, 504],
		allowed_methods=["GET", "POST"]
	)
	s.mount("https://", HTTPAdapter(max_retries=retries))
	s.mount("http://", HTTPAdapter(max_retries=retries))
	return s

SESSION = make_session()

# ==== OpenAI Embedding ========================================================

def get_embedding(text: str) -> List[float]:
	"""Erzeuge Embedding mit OpenAI; fällt bei Fehlern auf Nullen zurück."""
	import openai
	openai.api_key = OPENAI_API_KEY
	try:
		res = openai.embeddings.create(model=OPENAI_MODEL, input=[text])
		vec = res.data[0].embedding
		return vec
	except Exception as e:
		print(f"❌ Embedding-Fehler: {e}")
		# Fallback auf 1536-Dim, falls Modell das nutzt
		return [0.0] * 1536

# ==== Milvus / Zilliz =========================================================

def connect_to_milvus():
	connections.connect(alias="default", uri=ZILLIZ_URI, token=ZILLIZ_TOKEN)

def ensure_collection(dim: int = 1536):
	"""Legt die Collection mit erweitertem Schema an, falls nicht vorhanden."""
	if utility.has_collection(COLLECTION_NAME):
		# Optional: Dim-Prüfung könnte hier ergänzt werden
		return

	fields = [
		FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=64),
		FieldSchema(name="nid", dtype=DataType.INT64),
		FieldSchema(name="title", dtype=DataType.VARCHAR, max_length=255),
		FieldSchema(name="ort", dtype=DataType.VARCHAR, max_length=255),
		FieldSchema(name="mitarbeiter", dtype=DataType.INT64),
		FieldSchema(name="auszubildende", dtype=DataType.INT64),
		FieldSchema(name="berufsbereiche", dtype=DataType.VARCHAR, max_length=2000),
		FieldSchema(name="ansprechpartner", dtype=DataType.VARCHAR, max_length=255),
		FieldSchema(name="ausbildungsberufe", dtype=DataType.VARCHAR, max_length=2000),
		FieldSchema(name="chunk", dtype=DataType.VARCHAR, max_length=2000),
		FieldSchema(name="vector", dtype=DataType.FLOAT_VECTOR, dim=dim),
	]
	schema = CollectionSchema(fields, description="Betriebe (RAG) – idempotent")
	col = Collection(name=COLLECTION_NAME, schema=schema)
	col.create_index(field_name="vector", index_params={
		"index_type": "IVF_FLAT",
		"metric_type": "IP",
		"params": {"nlist": 1024}
	})
	col.load()

def delete_by_nid(nid: int):
	col = Collection(COLLECTION_NAME)
	expr = f"nid == {nid}"
	try:
		col.delete(expr)
	except Exception as e:
		print(f"⚠️ Delete für nid={nid} fehlgeschlagen (evtl. leer): {e}")

def insert_rows(rows: List[Dict]):
	if not rows:
		return 0
	col = Collection(COLLECTION_NAME)
	# Spaltenreihenfolge exakt zum Schema
	data = [
		[r["id"] for r in rows],
		[r["nid"] for r in rows],
		[r.get("title", "")[:255] for r in rows],
		[r.get("ort", "")[:255] for r in rows],
		[int(r["mitarbeiter"]) if str(r.get("mitarbeiter", "")).isdigit() else 0 for r in rows],
		[int(r["auszubildende"]) if str(r.get("auszubildende", "")).isdigit() else 0 for r in rows],
		[r.get("berufsbereiche", "")[:2000] for r in rows],
		[r.get("ansprechpartner", "")[:255] for r in rows],
		[r.get("ausbildungsberufe", "")[:2000] for r in rows],
		[r.get("chunk", "")[:2000] for r in rows],
		[r["vector"] for r in rows],
	]
	col.insert(data)
	return len(rows)

# ==== Drupal JSON:API =========================================================

def fetch_page(offset: int) -> Dict:
	url = f"{BASE_URL}?include={INCLUDE}&page[limit]={PAGE_LIMIT}&page[offset]={offset}&sort=changed"
	r = SESSION.get(url, timeout=30)
	r.raise_for_status()
	return r.json()

def fetch_since(changed_gt: Optional[int], offset: int) -> Dict:
	# Drupal 'changed' ist Unix-Timestamp; filter: filter[changed][value][GT]
	base = f"{BASE_URL}?include={INCLUDE}&page[limit]={PAGE_LIMIT}&page[offset]={offset}&sort=changed"
	if changed_gt:
		base += f"&filter[changed][condition][path]=changed&filter[changed][condition][operator]=%3E&filter[changed][condition][value]={changed_gt}"
	r = SESSION.get(base, timeout=30)
	r.raise_for_status()
	return r.json()

def paginate_all(incremental: bool, since_ts: Optional[int]) -> Tuple[List[Dict], Dict[Tuple[str, str], Dict]]:
	all_data: List[Dict] = []
	included_map: Dict[Tuple[str, str], Dict] = {}
	offset, page_no = 0, 1
	while True:
		page = fetch_since(since_ts, offset) if incremental else fetch_page(offset)
		data = page.get("data", [])
		if not data:
			break
		all_data.extend(data)
		for inc in page.get("included", []) or []:
			included_map[(inc["type"], inc["id"])] = inc
		print(f"🔄 Seite {page_no}: +{len(data)} Einträge (offset={offset})")
		offset += PAGE_LIMIT
		page_no += 1
		time.sleep(0.2)
	return all_data, included_map

# ==== Normalisierung / Chunking ==============================================

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")

def html_to_text(html: str) -> str:
	text = TAG_RE.sub(" ", html or "")
	return WS_RE.sub(" ", text).strip()

def normalize_text(t: str) -> str:
	return WS_RE.sub(" ", (t or "").strip().lower())

def stable_id(nid: int, chunk_text: str) -> str:
	"""Deterministische ID: sha256(nid:normalized_text) – 64 hex chars."""
	norm = normalize_text(chunk_text)
	return hashlib.sha256(f"{nid}:{norm}".encode("utf-8")).hexdigest()

def get_attr(obj: Dict, path: List[str], default=""):
	cur = obj
	for p in path:
		if not isinstance(cur, dict):
			return default
		cur = cur.get(p, {})
	return cur if cur else default

def extract_list_from_relationship(betrieb: Dict, rel_name: str, included: Dict) -> List[str]:
	out = []
	rel = betrieb.get("relationships", {}).get(rel_name, {}).get("data", []) or []
	for ref in rel:
		inc = included.get((ref["type"], ref["id"]))
		if inc:
			name = inc.get("attributes", {}).get("name", "")
			if name:
				out.append(name)
	return out

def extract_contact(betrieb: Dict) -> Tuple[str, str, str, str]:
	"""Versucht sinnvolle Felder für Ansprechpartner/Ort/Website/Telefon zu finden."""
	attrs = betrieb.get("attributes", {}) or {}
	# Viele Sites mappen Ort in Adresse. Wir versuchen einfache Heuristiken:
	ort = attrs.get("field_ort", "") or ""
	if not ort:
		addr = attrs.get("field_adresse", "") or ""
		# Simple Extraktion: Stadt nach 'Ort:' bzw. am Ende
		m = re.search(r"Ort\\s*:\\s*([^,\\n]+)", addr)
		if m:
			ort = m.group(1).strip()
	ansprechpartner = attrs.get("field_ansprechpartner", "") or ""
	website = attrs.get("field_website", "") or attrs.get("field_homepage", "") or ""
	telefon = attrs.get("field_telefon", "") or ""
	return ansprechpartner, ort, website, telefon

def build_profile_chunk(attrs: Dict, ansprechpartner: str, ort: str,
						berufsbereiche: List[str], ausbildungsberufe: List[str]) -> str:
	title = attrs.get("title", "")
	mitarbeiter = attrs.get("field_mitarbeiter") or ""
	auszubildende = attrs.get("field_auszubildende") or ""
	telefon = attrs.get("field_telefon") or ""
	email = attrs.get("field_email_ansprechpartner") or attrs.get("field_email") or ""
	website = attrs.get("field_website") or ""
	arbeitsbereiche_html = get_attr({"a": attrs}, ["a", "field_arbeitsbereiche", "value"], "")
	erwartungen_html = get_attr({"a": attrs}, ["a", "field_erwartungen", "value"], "")
	arbeitsbereiche = html_to_text(arbeitsbereiche_html)
	erwartungen = html_to_text(erwartungen_html)

	parts = [
		f"Firma: {title}",
		f"Ort: {ort}" if ort else "",
		f"Mitarbeiter: {mitarbeiter}" if mitarbeiter else "",
		f"Auszubildende: {auszubildende}" if auszubildende else "",
		f"Telefon: {telefon}" if telefon else "",
		f"E-Mail: {email}" if email else "",
		f"Website: {website}" if website else "",
		f"Ansprechpartner: {ansprechpartner}" if ansprechpartner else "",
		f"Arbeitsbereiche: {arbeitsbereiche}" if arbeitsbereiche else "",
		f"Erwartungen: {erwartungen}" if erwartungen else "",
		"Ausbildungsberufe: " + ", ".join(ausbildungsberufe) if ausbildungsberufe else "",
		"Berufsbereiche: " + ", ".join(berufsbereiche) if berufsbereiche else "",
	]
	chunk = " ".join([p for p in parts if p]).strip()
	# truncate defensiv
	return chunk[:1900]

def extract_chunks_for_betrieb(betrieb: Dict, included: Dict) -> Tuple[int, str, List[Dict]]:
	"""Gibt (nid, title, rows[]) zurück – rows enthalten bereits vector=None (wird später gefüllt)."""
	nid_str = betrieb.get("id")
	nid = int(re.sub(r"\\D", "", nid_str)) if nid_str and re.search(r"\\d", nid_str) else 0

	attrs = betrieb.get("attributes", {}) or {}
	title = attrs.get("title", "")

	ansprechpartner, ort, website, telefon = extract_contact(betrieb)

	# Beziehungen
	ausbildungsberufe_names = extract_list_from_relationship(betrieb, "field_ausbildungsberufe", included)
	# aus diesen Ausbildungsberufen die Berufsbereiche einsammeln (falls included)
	berufsbereiche_names = []
	rel = betrieb.get("relationships", {}).get("field_ausbildungsberufe", {}).get("data", []) or []
	for ref in rel:
		inc = included.get((ref["type"], ref["id"]))
		if not inc:
			continue
		bb_rel = inc.get("relationships", {}).get("field_berufsbereich", {}).get("data", []) or []
		for bb in bb_rel:
			inc_bb = included.get((bb["type"], bb["id"]))
			if inc_bb:
				name = inc_bb.get("attributes", {}).get("name", "")
				if name:
					berufsbereiche_names.append(name)
	# Duplikate entfernen
	berufsbereiche_names = sorted(set(berufsbereiche_names))

	# Profil-Chunk zusammenstellen (ein Chunk je Betrieb ist OK; du kannst hier auch mehrere bauen)
	chunk_text = build_profile_chunk(attrs, ansprechpartner, ort, berufsbereiche_names, ausbildungsberufe_names)

	row = {
		"nid": nid,
		"title": title,
		"ort": ort,
		"mitarbeiter": attrs.get("field_mitarbeiter") or 0,
		"auszubildende": attrs.get("field_auszubildende") or 0,
		"berufsbereiche": ", ".join(berufsbereiche_names),
		"ansprechpartner": ansprechpartner,
		"ausbildungsberufe": ", ".join(ausbildungsberufe_names),
		"chunk": chunk_text,
	}
	# deterministische ID
	row_id = stable_id(nid, chunk_text)
	row["id"] = row_id

	return nid, title, [row]

# ==== State Management (inkrementell) =========================================

def load_state() -> Dict:
	if os.path.exists(STATE_FILE):
		try:
			return json.load(open(STATE_FILE, "r", encoding="utf-8"))
		except Exception:
			pass
	return {"last_success_changed": 0}

def save_state(state: Dict):
	tmp = STATE_FILE + ".tmp"
	with open(tmp, "w", encoding="utf-8") as f:
		json.dump(state, f)
	os.replace(tmp, STATE_FILE)

# ==== Hauptablauf ==============================================================

def main():
	parser = argparse.ArgumentParser(description="Indexiere Betriebe in Milvus (idempotent, inkrementell).")
	parser.add_argument("--incremental", action="store_true", help="Nur seit letztem erfolgreichen Lauf (Drupal 'changed').")
	parser.add_argument("--full", action="store_true", help="Vollständiger Reindex (ignoriert State).")
	args = parser.parse_args()

	if not ZILLIZ_URI or not ZILLIZ_TOKEN:
		raise SystemExit("❌ ZILLIZ_URI / ZILLIZ_TOKEN fehlen (.env)")

	connect_to_milvus()
	ensure_collection()

	# Drupal Page Loop
	state = load_state()
	since_ts = None
	if args.incremental and not args.full:
		since_ts = int(state.get("last_success_changed") or 0)

	data, included = paginate_all(incremental=bool(since_ts), since_ts=since_ts)

	print(f"📦 Zu verarbeitende Betriebe: {len(data)}")

	inserted = 0
	replaced_nodes = 0
	errors = 0

	# Für jeden Betrieb: Rows bauen, delete-by-nid, Embedding erzeugen, einfügen
	for item in data:
		try:
			nid, title, rows = extract_chunks_for_betrieb(item, included)
			if not rows or not nid:
				continue

			# Embeddings erzeugen (ein Chunk pro Betrieb hier)
			for r in rows:
				r["vector"] = get_embedding(r["chunk"])

			# Alte Chunks dieses Betriebs entfernen (ersetzt statt Duplikate)
			delete_by_nid(nid)
			replaced_nodes += 1

			# Einfügen
			inserted += insert_rows(rows)
			print(f"✅ {title} (nid={nid}): {len(rows)} Chunk(s) gespeichert.")
		except Exception as e:
			errors += 1
			print(f"❌ Fehler bei nid={item.get('id')} – {e}")

		# kleine Pause gegen Rate Limits
		time.sleep(0.05)

	# State aktualisieren (bei Erfolg, d. h. keine Exceptions auf oberster Ebene)
	if not args.full:
		now_ts = int(datetime.now(timezone.utc).timestamp())
		state["last_success_changed"] = now_ts
		save_state(state)

	print("—" * 60)
	print(f"📊 Summary: inserted={inserted}, replaced_nodes={replaced_nodes}, errors={errors}")
	if args.incremental:
		print(f"🕒 Neuer last_success_changed: {state['last_success_changed']}")
	print("🎉 Fertig.")

if __name__ == "__main__":
	main()