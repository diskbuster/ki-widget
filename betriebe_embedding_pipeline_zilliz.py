
import requests
import json
import time
import os
import openai
from pymilvus import Collection, connections, FieldSchema, CollectionSchema, DataType, utility
from typing import List, Dict
from uuid import uuid4

### ================================================
### 🔧 KONFIGURATION
### ================================================
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "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")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "text-embedding-3-small")
ZILLIZ_URI = os.getenv("ZILLIZ_URI", "https://in03-310999081a59c75.serverless.gcp-us-west1.cloud.zilliz.com")
ZILLIZ_TOKEN = os.getenv("ZILLIZ_TOKEN", "c08d1fe2758bf33bc4a7ba7f37f335f807c4e97b109c65edbc8441867f0e1fa886aee4536445d0e8eaaffbc44a4f905ee6812937")
COLLECTION_NAME = os.getenv("MILVUS_COLLECTION", "betriebe_chunks")
BASE_URL = os.getenv("DRUPAL_API_BASE", "https://www.ausbildungsregion-osnabrueck.de/jsonapi/node/betrieb")
INCLUDE = "uid,field_ausbildungsberufe,field_ausbildungsberufe.field_berufsbereich,field_betriebsart"
LIMIT = 50

### 🔐 Verbindung zu Zilliz Cloud ###
def connect_to_milvus():
    from pymilvus import connections
    connections.connect(
        alias="auregios",
        uri=ZILLIZ_URI,
        token=ZILLIZ_TOKEN
    )

### 🧠 Initialisiere OpenAI ###
openai.api_key = OPENAI_API_KEY

### 🧱 Collection anlegen (falls nicht vorhanden) ###
def create_collection():
    from pymilvus import Collection, FieldSchema, CollectionSchema, DataType, utility
    if utility.has_collection(COLLECTION_NAME):
        return
    fields = [
        FieldSchema(name="id", dtype=DataType.VARCHAR, is_primary=True, max_length=36),
        FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=2000),
        FieldSchema(name="betrieb", dtype=DataType.VARCHAR, max_length=255),
        FieldSchema(name="berufe", dtype=DataType.VARCHAR, max_length=1000),
        FieldSchema(name="vector", dtype=DataType.FLOAT_VECTOR, dim=1536)
    ]
    schema = CollectionSchema(fields, description="Chunks von Ausbildungsbetrieben")
    collection = Collection(name=COLLECTION_NAME, schema=schema)
    collection.load()

### 📄 API-Daten laden ###
def fetch_all_betriebe():
    all_data, all_included = [], {}
    offset, seite = 0, 1
    while True:
        url = f"{BASE_URL}?include={INCLUDE}&page[limit]={LIMIT}&page[offset]={offset}"
        print(f"🔄 Lade Seite {seite} (offset {offset}) ...")
        try:
            resp = requests.get(url)
            resp.raise_for_status()
            page = resp.json()
        except Exception as e:
            print(f"❌ Fehler: {e}")
            break
        daten = page.get("data", [])
        if not daten:
            break
        all_data.extend(daten)
        for entry in page.get("included", []):
            all_included[(entry["type"], entry["id"])] = entry
        offset += LIMIT
        seite += 1
        time.sleep(0.5)
    return all_data, all_included

### 📦 Chunking-Funktion ###
def extract_chunks(betrieb: Dict, included: Dict) -> List[Dict]:
    chunks = []
    title = betrieb.get("attributes", {}).get("title", "")
    nid = betrieb.get("id")
    body = betrieb.get("attributes", {}).get("field_arbeitsbereiche", {}).get("value", "")
    if not body:
        return []
    paragraphs = [p.strip() for p in body.replace("<br>", "\n").split("</p>") if p.strip()]
    berufe = []
    for b in betrieb.get("relationships", {}).get("field_ausbildungsberufe", {}).get("data", []):
        ref = included.get((b["type"], b["id"]))
        if ref:
            berufe.append(ref.get("attributes", {}).get("name", ""))
    for para in paragraphs:
        clean = para.replace("<p>", "").replace("\n", " ").strip()
        if clean:
            chunks.append({
                "id": str(uuid4()),
                "text": clean,
                "betrieb": title,
                "berufe": ", ".join(berufe)
            })
    return chunks

### 🧠 OpenAI Embedding ###
def get_embedding(text: str) -> List[float]:
    try:
        res = openai.embeddings.create(model=OPENAI_MODEL, input=[text])
        return res.data[0].embedding
    except Exception as e:
        print(f"❌ Embedding-Fehler: {e}")
        return [0.0] * 1536

### 💾 Speicherung in Milvus ###
def store_chunks(chunks: List[Dict]):
    from pymilvus import Collection
    collection = Collection(COLLECTION_NAME)
    to_insert = [[], [], [], [], []]
    for chunk in chunks:
        to_insert[0].append(chunk["id"])
        to_insert[1].append(chunk["text"])
        to_insert[2].append(chunk["betrieb"])
        to_insert[3].append(chunk["berufe"])
        to_insert[4].append(get_embedding(chunk["text"]))
    collection.insert(to_insert)
    print(f"✅ {len(chunks)} Chunks gespeichert.")

### 🚀 Hauptablauf ###
if __name__ == "__main__":
    connect_to_milvus()
    create_collection()
    data, included = fetch_all_betriebe()
    all_chunks = []
    for betrieb in data:
        all_chunks.extend(extract_chunks(betrieb, included))
    store_chunks(all_chunks)
    print("🎉 Fertig!")
