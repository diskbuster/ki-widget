import { useState, useRef, useEffect } from "react";
import { ChatMessage } from "./components/ChatMessage";
import { ChatInput } from "./components/ChatInput";
import { X, RotateCcw } from "lucide-react";

const API_ENDPOINT = "https://botserver.lab49.de";

interface AssistantItem {
  name: string;
  ort: string;
  pfad: string;                 // z.B. "node/1234" oder "betrieb/foo"
  ausbildungsberufe?: string[];
}
interface AssistantPayload {
  items: AssistantItem[];
  includeBerufeLink?: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  payload?: AssistantPayload;   // <-- NEU: strukturierte Cards
}

interface WidgetSettings {
  welcome_text: string;
  title: string;
  show_poweredby?: boolean;
  input_placeholder?: string;
  loading_api?: string;
  loading_openai?: string;
  tooltip_reset?: string;
  tooltip_close?: string;
  loading_app?: string;
  predefined_questions?: string[];
}

const STORAGE_KEYS = {
  THREAD_ID: "chatThreadId",
  MESSAGES: "chatMessages",
} as const;

// Type Guard: erkennt unser AssistantPayload sicher
const isAssistantPayload = (obj: any): obj is AssistantPayload => {
  return (
    obj &&
    typeof obj === "object" &&
    Array.isArray(obj.items) &&
    obj.items.every(
      (it: any) =>
        it &&
        typeof it === "object" &&
        typeof it.name === "string" &&
        typeof it.ort === "string" &&
        typeof it.pfad === "string"
    )
  );
};

// Hilfsfunktion: prüft, ob ein String vollständiges JSON-Objekt enthält
const looksLikeCompleteJson = (s: string) => {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  const t = s.trim();
  return depth === 0 && t.startsWith("{") && t.endsWith("}");
};

function App() {
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.MESSAGES);
    return saved ? JSON.parse(saved) : [];
  });
  const [settings, setSettings] = useState<WidgetSettings>({
    welcome_text: "Willkommen! Wie kann ich Ihnen heute helfen?",
    title: "Auregios Chatbot",
    show_poweredby: true,
    input_placeholder: "Schreibe Deine Frage...",
    loading_api: "Ich denke nach ...",
    loading_openai: "Ich denke nach ...",
    tooltip_reset: "Chat zurücksetzen",
    tooltip_close: "Chat schließen",
    loading_app: "Chat laden...",
    predefined_questions: [
      "Welche Ausbildungsberufe gibt es?",
      "Finde Malerbetriebe in Melle.",
    ],
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [threadId, setThreadId] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEYS.THREAD_ID);
  });
  const [isLoading, setIsLoading] = useState(true);
  const [id, setId] = useState<string | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const widgetId = params.get("id");

        if (widgetId) {
          setId(widgetId);
          const response = await fetch(`${API_ENDPOINT}/settings?id=${widgetId}`);
          let loadedSettings: WidgetSettings;
          if (response.ok) {
            loadedSettings = { ...settings, ...(await response.json()) };
          } else {
            throw new Error("Failed to load settings");
          }
          setSettings(loadedSettings);
        }
      } catch (error) {
        console.error("Fehler beim Laden der Einstellungen:", error);
        setSettings((prev) => ({
          ...prev,
          welcome_text:
            prev.welcome_text || "Willkommen! Wie kann ich Ihnen heute helfen?",
          title: prev.title || "Auregios Chatbot",
          input_placeholder: prev.input_placeholder || "Schreibe Deine Frage...",
          loading_api: prev.loading_api || "Ich denke nach ...",
          loading_openai: prev.loading_openai || "Ich denke nach ...",
          tooltip_reset: prev.tooltip_reset || "Chat zurücksetzen",
          tooltip_close: prev.tooltip_close || "Chat schließen",
          loading_app: prev.loading_app || "Chat laden...",
        }));
      } finally {
        setIsLoading(false);
        setTimeout(scrollToBottom, 500);
      }
    };

    loadSettings();
  }, []);

  useEffect(() => {
    setTimeout(scrollToBottom, 100);
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.MESSAGES, JSON.stringify(messages));
  }, [messages]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center">
        <div className="mt-4 text-gray-600">
          {settings.loading_app || "Chat laden..."}
        </div>
      </div>
    );
  }

  const handleSend = async (content: string) => {
    // 1) User-Nachricht direkt hinzufügen
    setMessages((prev) => [...prev, { role: "user", content }]);
    setIsStreaming(true);

    // 2) Platzhalter für Assistant einfügen (wird live aktualisiert)
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: settings.loading_api || "Ich denke nach ..." },
    ]);
    const assistantIndex = messages.length + 1; // Index des Platzhalters

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (threadId) headers["x-thread-id"] = threadId;

      const params = new URLSearchParams(window.location.search);
      const widgetId = params.get("id") || null;

      const response = await fetch(`${API_ENDPOINT}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: content,
          widgetId,
          settings,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      // Buffer für evtl. finalen JSON-Block (Cards)
      let jsonBuf = "";
      let cardsDelivered = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Server sendet zeilenweise "data: ..."
        const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            // Falls noch kompletter JSON im Buffer
            if (!cardsDelivered && looksLikeCompleteJson(jsonBuf)) {
              try {
                const json = JSON.parse(jsonBuf);
                if (isAssistantPayload(json)) {
                  setMessages((prev) => {
                    const next = [...prev];
                    next[assistantIndex] = { role: "assistant", content: "", payload: json };
                    return next;
                  });
                  cardsDelivered = true;
                }
              } catch {
                // ignorieren
              }
            }
            break;
          }

          // Versuche zunächst, ob dies ein finaler JSON-Block ist (Cards)
          jsonBuf += payload;
          if (looksLikeCompleteJson(jsonBuf)) {
            try {
              const obj = JSON.parse(jsonBuf);

              // Fall A: ThreadInfo
              if (obj?.info?.id) {
                setThreadId(obj.info.id);
                localStorage.setItem(STORAGE_KEYS.THREAD_ID, obj.info.id);
                jsonBuf = ""; // Info verbraucht, Buffer leeren
                continue;
              }

              // Fall B: strukturierte Cards
              if (isAssistantPayload(obj)) {
                setMessages((prev) => {
                  const next = [...prev];
                  next[assistantIndex] = { role: "assistant", content: "", payload: obj };
                  return next;
                });
                cardsDelivered = true;
                jsonBuf = "";
                continue;
              }

              // Fall C: Token-Stream { content: "..." }
              if (typeof obj?.content === "string") {
                const token = obj.content;
                setMessages((prev) => {
                  const next = [...prev];
                  const current = next[assistantIndex];
                  // Falls bereits Cards gesetzt wurden, keine Tokens mehr anhängen
                  if (current.payload) return next;
                  next[assistantIndex] = {
                    role: "assistant",
                    content: (current.content || "") + token,
                  };
                  return next;
                });
                jsonBuf = "";
                continue;
              }

              // Unbekannte Struktur – Buffer leeren, damit nichts stehen bleibt
              jsonBuf = "";
            } catch {
              // JSON noch nicht komplett – weiter puffern
            }
          } else {
            // JSON (noch) nicht komplett; es könnte aber auch ein Token-Fragment sein,
            // das nicht als gültiges JSON daherkommt. Diese Variante
            // (plain-Tokens ohne {content}) unterstützen wir hier bewusst nicht,
            // da dein Server immer JSON in "data:" liefert.
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content:
            "Entschuldigung, es gab einen Fehler bei der Kommunikation mit dem Server. Bitte versuchen Sie es später erneut.",
        };
        return next;
      });
    } finally {
      setIsStreaming(false);
      setTimeout(scrollToBottom, 50);
    }
  };

  const handlePredefinedQuestionClick = (question: string) => {
    handleSend(question);
  };

  const handleClose = () => {
    window.parent.postMessage("close-chat", "*");
  };

  const handleReset = () => {
    setMessages([]);
    setThreadId(null);
    localStorage.removeItem(STORAGE_KEYS.THREAD_ID);
    localStorage.removeItem(STORAGE_KEYS.MESSAGES);
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      <div className="flex items-center justify-between p-4 border-b border-gray-200">
        <h1 className="text-xl font-semibold">{settings.title}</h1>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-300 hover:text-gray-800 relative group"
            aria-label={settings.tooltip_reset}
          >
            <RotateCcw className="w-5 h-5" />
            <span className="z-10 absolute text-nowrap right-0 mt-3 opacity-0 group-hover:opacity-100 bg-gray-800 text-white text-xs py-1 px-2 rounded transition-opacity delay-500 pointer-events-none">
              {settings.tooltip_reset}
            </span>
          </button>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors relative group"
            aria-label={settings.tooltip_close}
          >
            <X className="w-5 h-5" />
            <span className="z-10 absolute text-nowrap right-0 mt-3 opacity-0 group-hover:opacity-100 bg-gray-800 text-white text-xs py-1 px-2 rounded transition-opacity delay-500 pointer-events-none">
              {settings.tooltip_close}
            </span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {/* Begrüßungstext */}
        {messages.length === 0 && settings.welcome_text && (
          <div className="text-center px-4 py-2 rounded-lg text-gray-600 mb-4">
            <p>{settings.welcome_text}</p>
            {settings.predefined_questions?.length ? (
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {settings.predefined_questions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => handlePredefinedQuestionClick(q)}
                    className="px-4 py-2 bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors cursor-pointer text-sm"
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {messages.map((message, index) => (
          <ChatMessage
            key={index}
            id={id}
            message={message}
            isStreaming={isStreaming && index === messages.length - 1}
            threadId={threadId}
            messageHistory={messages}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        settings={{ input_placeholder: settings.input_placeholder }}
      />

      {settings.show_poweredby && (
        <a
          href="https://kasper.digital"
          target="_blank"
          className="pb-2 bg-white text-center text-xs text-gray-500"
          rel="noopener noreferrer"
        >
          Powered by kasper.digital
        </a>
      )}

      {/* einfache Card-Styles (falls du Tailwind nutzt, kannst du das auch in CSS auslagern) */}
      <style>{`
        .card {
          background: #ffffff;
          border: 1px solid #e0e0e0;
          border-radius: 12px;
          padding: 1rem 1.25rem;
          margin-bottom: 0.75rem;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
          transition: box-shadow 0.2s ease;
        }
        .card:hover { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); }
        .card h3 { margin: 0 0 6px 0; font-size: 1.1rem; font-weight: 700; }
        .card p { margin: 4px 0 0 0; font-size: 0.95rem; color: #444; }
        .card ul { margin: 8px 0 0 0; padding-left: 1.25rem; list-style: disc; color: #333; font-size: 0.95rem; }
        .card li { margin-bottom: 2px; }
      `}</style>
    </div>
  );
}

export default App;