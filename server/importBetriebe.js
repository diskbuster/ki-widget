import fetch from "node-fetch";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import dotenv from "dotenv";
import pLimit from "p-limit"; // Import p-limit for concurrency
dotenv.config();

const BASE_URL =
  "https://www.ausbildungsregion-osnabrueck.de/jsonapi/node/betrieb";
const INCLUDE =
  "uid,field_ausbildungsberufe,field_ausbildungsberufe.field_berufsbereich,field_betriebsart";
const PAGE_LIMIT = 50;

const ZILLIZ_URI = process.env.ZILLIZ_URI;
const ZILLIZ_TOKEN = process.env.ZILLIZ_TOKEN;
const COLLECTION = process.env.ZILLIZ_COLLECTION || "betriebe_chunks_jsonapi";

const milvusClient = new MilvusClient({
  address: process.env.ZILLIZ_URI,
  token: process.env.ZILLIZ_TOKEN,
});

function extractChunk(betrieb) {
  const attr = betrieb.attributes;
  if (!attr) {
    console.warn(
      "⚠️ Betrieb ohne Attribute übersprungen:",
      betrieb?.id || "unbekannt", // Corrected 'betriebs' to 'betrieb'
    );
    return null;
  }

  const name = attr.title || "Unbenannt";
  const ort = attr.field_ort || "Ort unbekannt";
  const mitarbeiter = attr.field_mitarbeiter || "n.a.";
  const auszubildende = attr.field_auszubildende || "n.a.";
  const website = attr.field_website || "";
  const telefon = attr.field_telefon || "";
  const mail = attr.field_email_ansprechpartner || "";
  const kontakt = attr.field_ansprechpartner || "";

  return (
    `Firma: ${name}\n` +
    `Ort: ${ort}\n` +
    `Mitarbeiter: ${mitarbeiter}, Auszubildende: ${auszubildende}\n` +
    `Telefon: ${telefon}\n` +
    `E-Mail: ${mail}\n` +
    `Website: ${website}\n` +
    `Ansprechpartner: ${kontakt}\n`
  );
}

async function fetchAllBetriebe() {
  console.log("🔄 Lade Betriebe aus JSON:API …");
  let allData = [];
  let url = `${BASE_URL}?include=${INCLUDE}&page[limit]=${PAGE_LIMIT}`;
  let more = true;

  while (more) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch-Fehler: ${res.status}`);
    const json = await res.json();
    allData = allData.concat(json.data);
    url = json.links?.next?.href;
    more = !!url;
  }

  console.log(`📦 ${allData.length} Betriebe geladen`);
  return allData;
}

async function updateMilvus(chunks) {
  console.log(`🧹 Lösche alte Daten aus Milvus (${COLLECTION})`);
  // Corrected deletion expression to target all records
  await milvusClient.deleteEntities({
    collection_name: COLLECTION,
    expr: "chunk != ''", // Damit wird alles gelöscht, was ein Chunk hat (also alles)
  });

  console.log("➕ Erzeuge Einbettungen und füge neue Einträge in Milvus ein …");
  const limit = pLimit(5); // Allow 5 concurrent embedding requests. Adjust as needed.

  const embeddingPromises = chunks.map(async (chunk) => {
    return limit(async () => {
      try {
        const res = await fetch(
          "http://homebase.lab49.de:11434/api/embeddings",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "nomic-embed-text", input: chunk }),
          },
        );
        if (!res.ok) {
          // Log specific error for failed embedding requests
          console.error(
            `❌ Fehler beim Erzeugen von Embedding für Chunk (erster 50 Zeichen): "${chunk.substring(0, 50)}..." Status: ${res.status}`,
          );
          return null; // Return null for failed embeddings
        }
        const { embedding } = await res.json();
        return { chunk, vector: embedding };
      } catch (error) {
        // Log general error during embedding process
        console.error(
          `❌ Unerwarteter Fehler beim Erzeugen von Embedding für Chunk (erster 50 Zeichen): "${chunk.substring(0, 50)}..." Error: ${error.message}`,
        );
        return null; // Return null for any exception
      }
    });
  });

  // Wait for all embedding promises to settle and filter out any null results
  const insertions = (await Promise.all(embeddingPromises)).filter(Boolean);

  if (insertions.length === 0) {
    console.log("⚠️ Keine Chunks zum Einfügen nach der Einbettung.");
    return; // Exit if no valid insertions
  }

  await milvusClient.insert({
    collection_name: COLLECTION,
    fields_data: insertions.map((i) => ({
      chunk: i.chunk,
      vector: i.vector,
    })),
  });

  console.log(`✅ Milvus aktualisiert mit ${insertions.length} Chunks`);
}

(async () => {
  try {
    const betriebe = await fetchAllBetriebe();
    // Filter out any null chunks that might come from extractChunk (e.g., missing attributes)
    const chunks = betriebe.map(extractChunk).filter(Boolean);
    await updateMilvus(chunks);
  } catch (err) {
    console.error("❌ Fehler beim Import:", err);
  }
})();
