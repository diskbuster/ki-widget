import React from "react";
import { Bot, ThumbsUp, ThumbsDown } from "lucide-react";
import he from "he";

const API_ENDPOINT = "https://botserver.lab49.de";

type Betrieb = {
  name: string;
  ort?: string | null;
  pfad: string; // "node/123" oder "/node/123"
  ausbildungsberufe?: string[] | null;
};

type AssistantJson = {
  type?: "cards";              // optional – nur zur Klarheit/Debug
  items: Betrieb[];
  includeBerufeLink?: boolean;
};

type AssistantPayload = AssistantJson | string;

interface ChatMessageProps {
  message: {
    role: "user" | "assistant";
    content: string; // JSON (bevorzugt) oder HTML (Fallback)
  };
  isStreaming?: boolean;
  threadId?: string | null;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  id?: string | null;
}

/* ---------- Utils ---------- */

function toProfilUrl(pfad: string): string {
  const clean = (pfad || "").replace(/^\/+/, "");
  return `https://www.ausbildungsregion-osnabrueck.de/${clean}`;
}

/** Entfernt Code-Fences & Entities, strippt SSE-Zeilen, extrahiert JSON mit "items". */
function robustParsePayload(raw: AssistantPayload): AssistantJson | null {
  if (raw == null) return null;

  // 0) Falls bereits Objekt
  if (typeof raw === "object") {
    const obj = raw as any;
    if (obj && Array.isArray(obj.items)) return obj as AssistantJson;
    return null;
  }

  // 1) Direktversuch: kompletter String als JSON
  try {
    const quick = JSON.parse(raw);
    if (quick && typeof quick === "object" && Array.isArray((quick as any).items)) {
      return quick as AssistantJson;
    }
  } catch {
    // weiter unten heuristisch
  }

  // 2) Entities & BOM entfernen
  let s = he.decode(String(raw)).replace(/^\uFEFF/, "").trim();

  // 3) Code fences entfernen
  s = s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/gi, "$1").trim();

  // 4) SSE-Zeilen → letzte sinnvolle data:-Zeile ziehen
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dataLines = lines.filter((l) => l.toLowerCase().startsWith("data:"));
  const candidateString = dataLines.length
    ? (dataLines.slice().reverse().find((l) => !/\[done\]/i.test(l)) || dataLines[0]).replace(/^data:\s*/i, "").trim()
    : s;

  // 5) Noch ein Direktversuch auf der Kandidaten-Zeile
  try {
    const quick2 = JSON.parse(candidateString);
    if (quick2 && typeof quick2 === "object" && Array.isArray((quick2 as any).items)) {
      return quick2 as AssistantJson;
    }
  } catch {
    // weiter
  }

  // 6) Braces-Heuristik: alle { .. }-Spannen prüfen
  const spans: string[] = [];
  const first = candidateString.indexOf("{");
  const last = candidateString.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    spans.push(candidateString.slice(first, last + 1));
  }
  const braceRegex = /{[\s\S]*?}/g;
  let m: RegExpExecArray | null;
  while ((m = braceRegex.exec(candidateString))) {
    const frag = m[0];
    if (!spans.includes(frag)) spans.push(frag);
  }

  for (const slice of spans) {
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === "object" && Array.isArray((obj as any).items)) {
        return obj as AssistantJson;
      }
    } catch {
      // ignore
    }
  }

  if (import.meta?.env?.MODE !== "production") {
    console.debug("[ChatMessage] Kein valides Assistant-JSON gefunden.", {
      rawSnippet: String(raw).slice(0, 200),
    });
  }
  return null;
}

/* ---------- Component ---------- */

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isStreaming,
  threadId,
  messageHistory = [],
  id,
}) => {
  const isUser = message.role === "user";

  const handleFeedback = async (type: "up" | "down") => {
    const previousUserMessage = messageHistory
      .slice(0, messageHistory.findIndex((m) => m.content === message.content))
      .reverse()
      .find((m) => m.role === "user");

    try {
      await fetch(`${API_ENDPOINT}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          messageOriginal: previousUserMessage?.content || "",
          messageContent: message.content,
          feedbackType: type,
          id: id || null,
        }),
      });
    } catch (error) {
      console.error("Error sending feedback:", error);
    }
  };

  // JSON-first Rendering (robust)
  const parsed = !isUser ? robustParsePayload(message.content) : null;

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""} mb-4`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-gray-200">
          <Bot className="w-5 h-5 text-gray-700" />
        </div>
      )}

      {/* ASSISTANT */}
      {!isUser && (
        <div className="max-w-[80%] flex flex-col group relative">
          <div
            className={`px-3 py-2 rounded-xl bg-gray-100 text-gray-800 ${
              isStreaming ? "animate-pulse" : ""
            }`}
          >
            {parsed ? (
              <div className="space-y-4">
                {parsed.items.map((b, idx) => {
                  const profilUrl = toProfilUrl(b.pfad);
                  const berufe =
                    Array.isArray(b.ausbildungsberufe) && b.ausbildungsberufe.length > 0
                      ? b.ausbildungsberufe
                      : null;

                  return (
                    <div key={idx} className="border rounded-lg p-4 bg-white shadow">
                      <h3 className="text-lg font-bold mb-2">
                        <a
                          href={profilUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-900 hover:underline"
                        >
                          {b.name}
                        </a>
                      </h3>

                      {b.ort && <p className="mb-2">Ort: {b.ort}</p>}

                      {berufe && (
                        <ul className="list-disc pl-6 space-y-1 mb-3">
                          {berufe.map((beruf, i) => (
                            <li key={i}>{beruf}</li>
                          ))}
                        </ul>
                      )}

                      <a href={profilUrl} target="_blank" rel="noopener noreferrer">
                        <button className="px-4 py-2 bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors cursor-pointer text-sm font-bold">
                          Jetzt Praktikum oder Ausbildung online anfragen!
                        </button>
                      </a>
                    </div>
                  );
                })}

                {parsed.includeBerufeLink && (
                  <div>
                    <a
                      href="https://www.ausbildungsregion-osnabrueck.de/berufelexikon"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <button className="px-4 py-2 bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors cursor-pointer text-sm font-bold">
                        Weitere Ausbildungsberufe findest Du in unserem Berufelexikon
                      </button>
                    </a>
                  </div>
                )}
              </div>
            ) : (
              // Fallback: rohe HTML-Antwort (nur wenn wirklich kein valides JSON gefunden wurde)
              <div
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{
                  __html: he
                    .decode(message.content)
                    .replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" '),
                }}
              />
            )}
          </div>

          {/* Feedback */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity delay-500 flex gap-1 absolute left-2 -bottom-6 px-2 py-1 bg-white rounded-lg shadow-md">
            <button
              onClick={(e) => {
                handleFeedback("up");
                const button = e.currentTarget;
                button.classList.add("-rotate-[20deg]");
                setTimeout(() => {
                  button.parentElement?.remove();
                }, 500);
              }}
              className="p-1 hover:bg-gray-200 rounded-full transition-colors transform transition-transform duration-150"
              aria-label="Thumbs up"
            >
              <ThumbsUp className="w-4 h-4 text-gray-500" />
            </button>
            <button
              onClick={(e) => {
                handleFeedback("down");
                const button = e.currentTarget;
                button.classList.add("-rotate-[20deg]");
                setTimeout(() => {
                  button.parentElement?.remove();
                }, 500);
              }}
              className="p-1 hover:bg-gray-200 rounded-full transition-colors transform transition-transform duration-150"
              aria-label="Thumbs down"
            >
              <ThumbsDown className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>
      )}

      {/* USER */}
      {isUser && (
        <div
          className={`max-w-[80%] px-3 py-2 rounded-xl bg-blue-600 text-white ${
            isStreaming ? "animate-pulse" : ""
          }`}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      )}
    </div>
  );
};