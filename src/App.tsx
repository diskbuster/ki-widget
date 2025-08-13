import { useState, useRef, useEffect } from "react";
// Importpfade ohne Dateierweiterung, wie in modernen React-Projekten üblich
import { ChatMessage } from "./components/ChatMessage";
import { ChatInput } from "./components/ChatInput";
import { X, RotateCcw } from "lucide-react";

const API_ENDPOINT = "https://botserver.lab49.de";

interface Message {
  role: "user" | "assistant";
  content: string;
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
  predefined_questions?: string[]; // Neu: Array für vorformulierte Fragen
}

const STORAGE_KEYS = {
  THREAD_ID: "chatThreadId",
  MESSAGES: "chatMessages",
} as const;

function App() {
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const [messages, setMessages] = useState<Message[]>(() => {
    const savedMessages = localStorage.getItem(STORAGE_KEYS.MESSAGES);
    return savedMessages ? JSON.parse(savedMessages) : [];
  });
  const [settings, setSettings] = useState<WidgetSettings>({
    welcome_text: "Willkommen! Wie kann ich Ihnen heute helfen?", // Begrüßungstext
    title: "Auregios Chatbot",
    show_poweredby: true,
    input_placeholder: "Schreibe Deine Frage...",
    loading_api: "Ich denke nach ...",
    loading_openai: "Ich denke nach ...",
    tooltip_reset: "Chat zurücksetzen",
    tooltip_close: "Chat schließen",
    loading_app: "Chat laden...",
    predefined_questions: [
      // Vorformulierte Fragen
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

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const widgetId = params.get("id");

        if (widgetId) {
          setId(widgetId);
          const response = await fetch(
            `${API_ENDPOINT}/settings?id=${widgetId}`,
          );
          let loadedSettings: WidgetSettings;
          if (response.ok) {
            // Merge default settings with loaded settings
            loadedSettings = { ...settings, ...(await response.json()) };
          } else {
            throw new Error("Failed to load settings");
          }
          setSettings(loadedSettings);
        }
      } catch (error) {
        // Fallback to default settings if loading fails
        console.error("Fehler beim Laden der Einstellungen:", error);
        setSettings((prevSettings) => ({
          ...prevSettings, // Behalte bestehende Defaults
          welcome_text:
            prevSettings.welcome_text ||
            "Willkommen! Wie kann ich Ihnen heute helfen?",
          title: prevSettings.title || "Auregios Chatbot",
          input_placeholder:
            prevSettings.input_placeholder || "Schreibe Deine Frage...",
          loading_api: prevSettings.loading_api || "Ich denke nach ...",
          loading_openai: prevSettings.loading_openai || "Ich denke nach ...",
          tooltip_reset: prevSettings.tooltip_reset || "Chat zurücksetzen",
          tooltip_close: prevSettings.tooltip_close || "Chat schließen",
          loading_app: prevSettings.loading_app || "Chat laden...",
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
    // Wenn die Nachricht von einem Button kommt, wird sie als "user" Nachricht hinzugefügt.
    const userMessage: Message = { role: "user", content };
    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (threadId) {
        headers["x-thread-id"] = threadId;
      }

      const params = new URLSearchParams(window.location.search);
      const widgetId = params.get("id") || null;

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: settings.loading_api || "Ich denke nach ...",
        },
      ]);

      // Hier wird der System-Prompt direkt an das Backend geschickt,
      // da die RAG-Logik dort angewendet wird.
      const response = await fetch(`${API_ENDPOINT}/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: content, // Sende den ursprünglichen Inhalt der Benutzernachricht
          widgetId,
          settings,
        }),
      });

      const reader = response.body?.getReader();
      let assistantMessage = "";

      setMessages((prev) => {
        const newMessages = [...prev];
        newMessages[newMessages.length - 1] = {
          role: "assistant" as const,
          content: settings.loading_openai || "Ich denke ...",
        };
        return newMessages;
      });

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = new TextDecoder().decode(value);
        const messages = text.split("\n\n");

        for (const message of messages) {
          if (message.startsWith("data: ")) {
            const data = message.slice(6);
            if (data === "[DONE]") break;

            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                assistantMessage += parsed.content;
                setMessages((prev) => {
                  const newMessages = [...prev];
                  newMessages[newMessages.length - 1] = {
                    role: "assistant",
                    content: assistantMessage,
                  };
                  return newMessages;
                });
              } else if (parsed.info) {
                setThreadId(parsed.info.id);
                localStorage.setItem(STORAGE_KEYS.THREAD_ID, parsed.info.id);
              }
            } catch (e) {
              console.error("Error parsing SSE message:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      // Fallback message in case of API error
      setMessages((prev) => {
        const newMessages = [...prev];
        newMessages[newMessages.length - 1] = {
          role: "assistant",
          content:
            "Entschuldigung, es gab einen Fehler bei der Kommunikation mit dem Server. Bitte versuchen Sie es später erneut.",
        };
        return newMessages;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  const handlePredefinedQuestionClick = (question: string) => {
    // Hier rufen wir handleSend auf, um die vorformulierte Frage zu verarbeiten
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
            {/* Vorformulierte Fragen als Buttons */}
            {settings.predefined_questions &&
              settings.predefined_questions.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2 mt-4">
                  {settings.predefined_questions.map((question, index) => (
                    <button
                      key={index}
                      onClick={() => handlePredefinedQuestionClick(question)}
                      className="px-4 py-2 bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200 transition-colors cursor-pointer text-sm"
                    >
                      {question}
                    </button>
                  ))}
                </div>
              )}
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

      <style>{`
        .card {
          background: #ffffff;
          border: 1px solid #e0e0e0;
          border-radius: 12px;
          padding: 1rem 1.25rem;
          margin-bottom: -15px;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
          transition: box-shadow 0.2s ease;
        }
        
        .card:hover {
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        
        .card h3 {
          margin-top: -40px;
          margin-bottom: -50px;
          font-size: 1.1rem;
          font-weight: bold;
        }
        
        .card p {
          margin: 10px 0 0 0;
          font-size: 0.95rem;
          color: #444;
        }
        
        .card ul {
          margin: -90px 0 -50px 0;
          padding-left: 1.25rem;
          list-style-type: disc;
          color: #333;
          font-size: 0.95rem;
        }
        
        .card li {
          margin-bottom: -35px;
        }
      `}</style>
    </div>
  );
}

export default App;
