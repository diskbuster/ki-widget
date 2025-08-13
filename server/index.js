import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { config } from "dotenv";
import { OpenAI } from "openai";
// Importiere nur MilvusClient. Das Collection-Objekt für Operationen wird nicht direkt instanziiert.
import { MilvusClient } from "@zilliz/milvus2-sdk-node"; // Korrekter Import für MilvusClient
import { TextEncoder, TextDecoder } from "util";

dotenv.config();

console.log("✅ Ollama + Milvus-Konfiguration:");
console.log(
  "🌍 Ollama URL:",
  process.env.OLLAMA_URL || "http://homebase.lab49.de:11434",
);
console.log("🧠 Modell:", process.env.OLLAMA_MODEL || "llama3");
console.log("📦 Milvus URI:", process.env.ZILLIZ_URI);
console.log("📦 Milvus Collection:", process.env.MILVUS_COLLECTION);

const app = express();
app.use(cors());
app.use(express.json());

const OLLAMA_URL = process.env.OLLAMA_URL || "http://homebase.lab49.de:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

const ZILLIZ_URI = process.env.ZILLIZ_URI;
const ZILLIZ_TOKEN = process.env.ZILLIZ_TOKEN;
const MILVUS_COLLECTION =
  process.env.MILVUS_COLLECTION || "betriebe_chunks_jsonapi";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialisiere MilvusClient mit dem Optionen-Objekt
const milvusClient = new MilvusClient({
  address: ZILLIZ_URI,
  token: ZILLIZ_TOKEN,
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    // 1. Embedding erzeugen
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userMessage,
    });
    const vector = embeddingResponse.data[0].embedding;

    // 2. Suche in Milvus (DIREKT auf milvusClient, unter Angabe des collection_name)
    const results = await milvusClient.search({
      collection_name: MILVUS_COLLECTION,
      data: [vector],
      anns_field: "vector",
      param: { metric_type: "COSINE", params: { nprobe: 10 } },
      limit: 3, // Erhöht auf 3, um mehr Kontext zu liefern
      output_fields: ["chunk"], // 'score' ist eine Standard-Eigenschaft des Treffers, nicht ein Feld aus der Collection
    });

    // Logging der vollständigen Milvus-Suchergebnisse zur Analyse
    console.log(
      "🔍 Milvus-Suchergebnisse (Rohdaten):",
      JSON.stringify(results, null, 2),
    );

    let topChunks = [];
    // Zusätzliches Debugging: Loggen, ob results.results ein Array ist und wie lang es ist
    console.log(
      "DEBUG: results.results ist Array?",
      Array.isArray(results.results),
    );
    if (Array.isArray(results.results)) {
      console.log("DEBUG: results.results Länge:", results.results.length);
    }

    if (
      results &&
      Array.isArray(results.results) &&
      results.results.length > 0
    ) {
      topChunks = results.results
        .filter((hit) => {
          const score = hit.score;
          const passesFilter = score > 0.1; // Filterkriterium beibehalten
          console.log(
            `DEBUG: Chunk-Score: ${score}, Passiert Filter (>0.1): ${passesFilter}, Chunk-ID: ${hit.id || "N/A"}`,
          ); // Log Score und Filterstatus
          return passesFilter;
        })
        .map((hit) => hit.chunk); // Zugriff direkt auf 'hit.chunk'

      console.log(
        "✅ Gefilterte Top Chunks nach Filtern (Anzahl:",
        topChunks.length,
        "):",
        topChunks,
      );
    } else {
      console.warn(
        "⚠️ Milvus-Suche lieferte keine gültigen Ergebnisse zum Filtern oder unerwartete Struktur. (topChunks bleibt leer)",
      );
    }

    const contextText = topChunks.join("\n\n");
    console.log(
      "📝 Generierter Kontext für Ollama (erste 500 Zeichen):",
      contextText.substring(0, 500) + (contextText.length > 500 ? "..." : ""),
    ); // Log die ersten 500 Zeichen des Kontexts
    if (contextText.length === 0) {
      console.warn(
        "⚠️ Der Kontext für Ollama ist leer. Dies kann zu Halluzinationen führen.",
      );
    }

    // Verbesserter Prompt mit detaillierteren Anweisungen an Ollama
    const basePrompt = process.env.BASE_PROMPT || "";
    const prompt = `${basePrompt}\n\nKontext:\n\n${contextText}\n\nFrage: ${userMessage}`;
    console.log(
      "📝 Vollständiger Prompt an Ollama (erste 1000 Zeichen):",
      prompt.substring(0, 1000) + (prompt.length > 1000 ? "..." : ""),
    );

    // 3. Anfrage an Ollama mit Streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      res.write(
        `data: ${JSON.stringify({ error: "Ollama-Fehler", status: response.status, statusText: response.statusText })}\n\n`,
      ); // Detailliertere Fehlermeldung
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const decoder = new TextDecoder("utf-8");
    let fullOllamaResponse = ""; // Sammeln der gesamten Ollama-Antwort

    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      fullOllamaResponse += text; // Fügen Sie den Text zum vollständigen Stream hinzu
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line || line.trim() === "" || line.trim() === "[DONE]") continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            res.write(
              `data: ${JSON.stringify({ content: parsed.response })}\n\n`,
            );
            res.flush?.();
          } else if (parsed.done) {
            // Dies ist der "done"-Block. Loggen Sie ihn und brechen Sie dann ab.
            console.log(
              "DEBUG: Ollama 'done' Block:",
              JSON.stringify(parsed, null, 2),
            );
            break; // Beende die Schleife, da der Stream beendet ist
          }
        } catch (err) {
          console.warn("⚠️ Ungültiger JSON-Teil (übersprungen):", line);
        }
      }
    }
    console.log(
      "DEBUG: Vollständige Rohantwort von Ollama:",
      fullOllamaResponse,
    ); // Loggen der gesamten Antwort
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Fehler:", error);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

app.post("/feedback", async (req, res) => {
  res.status(200).json({ message: "Feedback erhalten" });
});

const PORT = process.env.PORT || 5544;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
