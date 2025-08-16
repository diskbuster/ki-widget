export {};

declare global {
  interface Window {
    initWidgetPlatform: (config: ChatWidgetConfig) => void;
  }
}

// Widget injection script
const IFRAME_ID = "widgetplatform-widget-oa-iframe";
const WIDGET_IFRAME_ENDPOINT = "https://botapp.lab49.de/index.html";

// Define the configuration interface
interface ChatWidgetConfig {
  id?: string;
  api?: string; // wenn gesetzt, überschreibt WIDGET_IFRAME_ENDPOINT
  buttonPosition?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  buttonColor?: string;
  buttonBackgroundColor?: string;
  buttonSize?: string;
  buttonMargin?: string;
  iframeWidth?: string;
  iframeHeight?: string;
  displayType?: "popup" | "modal";
  modalBackdrop?: boolean;
  svgIcon?: string;
}

// Default configuration
const defaultConfig: Omit<ChatWidgetConfig, "id"> = {
  buttonPosition: "bottom-right",
  buttonColor: "#ffffff",
  buttonBackgroundColor: "#2563eb",
  buttonSize: "3.5rem",
  buttonMargin: "1rem",
  iframeWidth: "400px",
  iframeHeight: "600px",
  displayType: "popup",
  modalBackdrop: true,
};

// Queue für frühe Aufrufe
interface WindowWithQueue extends Window {
  initWidgetPlatform: (config: ChatWidgetConfig) => void;
  _chatWidgetQueue?: ChatWidgetConfig[];
}

// Initialize queue
(window as WindowWithQueue)._chatWidgetQueue =
  (window as WindowWithQueue)._chatWidgetQueue || [];

// Temp-Function, die in die Queue pusht
if (!(window as WindowWithQueue).initWidgetPlatform) {
  (window as WindowWithQueue).initWidgetPlatform = (
    config: ChatWidgetConfig
  ) => {
    (window as WindowWithQueue)._chatWidgetQueue?.push(config);
  };
}

// Backdrop
function createBackdrop() {
  const backdrop = document.createElement("div");
  backdrop.id = "openai-chat-widget-backdrop";
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 999998;
    opacity: 0;
    transition: opacity 0.3s;
  `;
  document.body.appendChild(backdrop);
  return backdrop;
}

let currentConfig: ChatWidgetConfig | null = null; // FIX: nach oben gezogen

function initWidgetPlatform(config: ChatWidgetConfig) {
  // Validate
  if (!config.id && !config.api) {
    console.error("Either Widget ID or API URL is required to initialize the chat widget");
    return;
  }

  // Merge
  const finalConfig = { ...defaultConfig, ...config };

  // FIX: aktuelle Config merken
  currentConfig = finalConfig;

  const button = document.createElement("button");
  // FIX: konsistente ID
  button.id = "widgetplatform-chat-widget-button";

  // Position
  const positionStyles = {
    "bottom-right": `bottom: ${finalConfig.buttonMargin}; right: ${finalConfig.buttonMargin};`,
    "bottom-left":  `bottom: ${finalConfig.buttonMargin}; left: ${finalConfig.buttonMargin};`,
    "top-right":    `top: ${finalConfig.buttonMargin}; right: ${finalConfig.buttonMargin};`,
    "top-left":     `top: ${finalConfig.buttonMargin}; left: ${finalConfig.buttonMargin};`,
  }[finalConfig.buttonPosition!];

  button.style.cssText = `
    display: flex; align-items: center; justify-content: center;
    width: ${finalConfig.buttonSize}; height: ${finalConfig.buttonSize};
    border: none; background-color: ${finalConfig.buttonBackgroundColor};
    color: ${finalConfig.buttonColor}; border-radius: 9999px;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
    position: fixed; ${positionStyles}; z-index: 50;
    transition: background-color .3s, opacity .3s, transform .2s ease;
    -webkit-font-smoothing: antialiased; cursor: pointer; transform: scale(1);
  `;

  button.addEventListener("mouseenter", () => {
    button.style.transform = "scale(1.05)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.transform = "scale(1)";
  });

  button.innerHTML = finalConfig.svgIcon
    ? finalConfig.svgIcon
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
         stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
       </svg>`;

  button.onclick = () => toggleChat(finalConfig);
  document.body.appendChild(button);
}

function createIframe(config: ChatWidgetConfig) {
  const iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;

  let positionStyles = "";
  let dimensions = "";

  if (config.displayType === "popup") {
    positionStyles = {
      "bottom-right": `bottom: ${config.buttonMargin}; right: ${config.buttonMargin};`,
      "bottom-left":  `bottom: ${config.buttonMargin}; left: ${config.buttonMargin};`,
      "top-right":    `top: ${config.buttonMargin}; right: ${config.buttonMargin};`,
      "top-left":     `top: ${config.buttonMargin}; left: ${config.buttonMargin};`,
    }[config.buttonPosition!];

    dimensions = `
      width: ${config.iframeWidth};
      height: ${config.iframeHeight};
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 100px);
    `;
  } else {
    positionStyles = `
      top: 50%; left: 50%; transform: translate(-50%, -50%) translateY(20px);
    `;
    dimensions = `
      width: min(${config.iframeWidth}, 90vw);
      height: min(${config.iframeHeight}, 90vh);
    `;
  }

  iframe.style.cssText = `
    box-sizing: border-box; position: fixed; ${positionStyles} ${dimensions}
    border: none; border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,.15);
    z-index: 999999; opacity: 0;
    transition: opacity .3s, transform .3s;
  `;

  // Quelle wählen: api (wenn gesetzt) sonst Endpoint + ?id
  iframe.src = config.api
    ? config.api
    : `${WIDGET_IFRAME_ENDPOINT}?id=${config.id}`;

  document.body.appendChild(iframe);
  return iframe;
}

function toggleChat(config: ChatWidgetConfig) {
  let iframe = document.getElementById(IFRAME_ID) as HTMLIFrameElement;
  // FIX: konsistente Button-ID
  const button = document.getElementById("widgetplatform-chat-widget-button") as HTMLButtonElement;
  let backdrop = document.getElementById("openai-chat-widget-backdrop") as HTMLDivElement;

  if (!iframe) {
    iframe = createIframe(config);
    if (config.displayType === "modal" && config.modalBackdrop) {
      backdrop = createBackdrop();
    }
    setTimeout(() => {
      iframe.style.opacity = "1";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(0)";
      } else {
        iframe.style.transform = "translate(-50%, -50%)";
        if (backdrop) backdrop.style.opacity = "1";
      }
      if (button) button.style.opacity = "0";
    }, 10);
  } else {
    if (iframe.style.opacity === "0") {
      iframe.style.opacity = "1";
      iframe.style.pointerEvents = "auto";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(0)";
      } else {
        iframe.style.transform = "translate(-50%, -50%)";
        if (backdrop) backdrop.style.opacity = "1";
      }
      if (button) button.style.opacity = "0";
      if (config.displayType === "modal" && config.modalBackdrop) {
        backdrop = createBackdrop();
      }
    } else {
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(20px)";
      } else {
        iframe.style.transform = "translate(-50%, -50%) translateY(20px)";
        if (backdrop) backdrop.style.opacity = "0";
      }
      if (button) button.style.opacity = "1";
      if (backdrop) setTimeout(() => backdrop.remove(), 300);
    }
  }
}

// Events
window.addEventListener("message", (event) => {
  if (event.data === "close-chat" && currentConfig) {
    toggleChat(currentConfig);
  }
});

document.addEventListener("click", (event) => {
  const backdrop = document.getElementById("openai-chat-widget-backdrop");
  if (event.target === backdrop && currentConfig) {
    toggleChat(currentConfig);
  }
});

// Globale Signatur (erneut, für TS)
declare global {
  interface Window {
    initWidgetPlatform: (config: ChatWidgetConfig) => void;
  }
}

window.initWidgetPlatform = initWidgetPlatform;

// Queue abarbeiten
function processQueue() {
  const win = window as WindowWithQueue;
  const queue = win._chatWidgetQueue || [];

  win.initWidgetPlatform = (config: ChatWidgetConfig) => {
    if (!config.id && !config.api) {
      console.error("Either Widget ID or API URL is required to initialize the chat widget");
      return;
    }
    const finalConfig = { ...defaultConfig, ...config };
    currentConfig = finalConfig; // FIX
    initWidgetPlatform(finalConfig);
  };

  while (queue.length > 0) {
    const config = queue.shift();
    if (config) win.initWidgetPlatform(config);
  }
}

processQueue();
window.dispatchEvent(new Event("chatWidgetLoaded"));