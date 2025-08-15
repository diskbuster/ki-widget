# KI Widget – Ollama + Milvus (Zilliz) Enabled Chatbot Widget

This is a **self-hosted clone** of [widget-oa](https://github.com/widgetplatform/widget-oa), adapted to work with **local Ollama models** and **Milvus** vector search via **Zilliz Cloud** for Retrieval-Augmented Generation (RAG).

It allows you to embed an AI chatbot on any website using a single `<script>` tag, with a customizable popup or modal interface, while running entirely on your own infrastructure.

---

## ✨ Features

- **Local AI with Ollama** – Use any Ollama-served model (e.g. LLaMA, Mistral, Gemma) as your chatbot brain.
- **Vector search with Milvus/Zilliz** – Retrieve relevant documents from your Milvus collection to provide context-aware answers.
- **RAG pipeline built-in** – Inject search results into the prompt before sending to Ollama.
- **Fully self-hosted** – No third-party API keys required; all requests go through your own server.
- **Customizable UI** – Colors, position, popup vs. modal, and branding via configuration.
- **Lightweight embed** – Add to any site via a `<script>` tag.
- **Secure server proxy** – Keeps API keys and internal endpoints hidden from the browser.

---

## ⚙️ How It Works

1. **Widget injection**  
   You add the provided `<script>` snippet to your website. It creates a floating chat button.

2. **UI loading**  
   When clicked, the button loads the React chat app inside an iframe.

3. **Server proxy**  
   The chat app sends messages to the Node.js server, not directly to Ollama or Milvus.

4. **Retrieval + Generation**  
   - The server queries **Milvus** (via Zilliz Cloud) for the top-K most relevant chunks.  
   - These chunks are added to the prompt as context.  
   - The combined prompt is sent to **Ollama** to generate a response.

5. **Streaming back to the UI**  
   The server streams the model’s output back to the chat interface.

---

## 🚀 Installation

.env file

# --- Ollama ---
# Default chat endpoint (do not include a trailing slash)
OLLAMA_API_URL=http://localhost:11434
# Model name as shown by `ollama list`
OLLAMA_MODEL=llama3

# --- Milvus / Zilliz ---
# Zilliz Cloud public endpoint (no protocol)
ZILLIZ_ENDPOINT=xxxxx.api.gcp.zillizcloud.com
# Zilliz Cloud API key
ZILLIZ_API_KEY=your_zilliz_api_key
# Milvus collection holding your embeddings
MILVUS_COLLECTION=my_collection
# Optional: top-K search results and score threshold
MILVUS_TOP_K=5
MILVUS_SCORE_THRESHOLD=0.0

# --- Embeddings ---
# Identifier for the embedding model you used to build the index
EMBEDDING_MODEL=all-MiniLM-L6-v2
# Optional: remote embedding service/base URL if you don’t embed locally
EMBEDDING_API_URL=

# --- Server ---
PORT=3000
NODE_ENV=production
# Optional CORS allowlist (comma-separated origins)
CORS_ORIGINS=http://localhost:5173,https://your-website.com


## Server

The server is built with Node.js and Express. It is used to communicate between the widget and the OpenAI API.

You can find the server in the `server` folder. The name will be `index.js`. You need to host this file in your website and use the right address to load it. This server is used to handle the chat history and the feedback. You have to implement storage feedback yourself or use widgetplatform.com.



## App (iframe target)

The app is the target for the iframe. It is built with React and Typescript.

You can find the app in the `dist/app` folder after building the project. The name will be `index.html`. You should host this file in your website and use the right address to load it.

If you don't want to use widgetplatform.com, you need to change `API_ENDPOINT` constant in the `App.tsx` and `components/ChatMessage.tsx` to point the right address of your server app (see section Server).


## Widget

You can find the widget in the `dist/widget` folder. The name will be `widget.iife.js`. Host this file in your website and use the right address to load it:

```html
<script src="https://your-server.example.com/widget.iife.js"></script>
<script>
  initWidgetPlatform({
	serverUrl: "https://your-server.example.com",
	displayType: "popup",          // "popup" or "modal"
	buttonColor: "#4F46E5",
	title: "Ask the AI",
	// Optional extras:
	// primaryColor: "#4F46E5",
	// position: "bottom-right"
  });
</script>
```


For complete configuration options, please refer to the `widget/inject.ts` or check online documentation: https://docs.widgetplatform.com/widget-oa/js-widget-configuration

