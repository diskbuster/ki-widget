import React from "react";
import { Bot, ThumbsUp, ThumbsDown } from "lucide-react";
import he from "he";

const API_ENDPOINT = "https://botserver.lab49.de";

interface ChatMessageProps {
  message: {
    role: "user" | "assistant";
    content: string;
  };
  isStreaming?: boolean;
  threadId?: string | null;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  id?: string | null;
}

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
      .slice(
        0,
        messageHistory.findIndex((m) => m.content === message.content),
      )
      .reverse()
      .find((m) => m.role === "user");

    try {
      await fetch(`${API_ENDPOINT}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""} mb-4`}>
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-gray-200">
          <Bot className="w-5 h-5 text-gray-700" />
        </div>
      )}

      {!isUser && (
        <div className="max-w-[80%] flex flex-col group relative">
          <div
            className={`px-3 py-2 rounded-xl
          bg-gray-100 text-gray-800
          ${isStreaming ? "animate-pulse" : ""}`}
          >
            <div
              className="whitespace-pre-wrap"
              dangerouslySetInnerHTML={{
                __html: he
                  .decode(message.content)
                  .replace(
                    /<a /g,
                    '<a target="_blank" rel="noopener noreferrer" ',
                  ),
              }}
            />
          </div>
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

      {isUser && (
        <div
          className={`max-w-[80%] px-3 py-2 rounded-xl
          bg-blue-600 text-white
          ${isStreaming ? "animate-pulse" : ""}`}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      )}
    </div>
  );
};
