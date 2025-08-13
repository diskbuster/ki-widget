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
  api?: string;
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

// At the start of the file, before any other code
// Create a queue for storing calls before script loads
interface WindowWithQueue extends Window {
  initWidgetPlatform: (config: ChatWidgetConfig) => void;
  _chatWidgetQueue?: ChatWidgetConfig[];
}

// Initialize queue if it doesn't exist
(window as WindowWithQueue)._chatWidgetQueue =
  (window as WindowWithQueue)._chatWidgetQueue || [];

// Create temporary function to queue calls
if (!(window as WindowWithQueue).initWidgetPlatform) {
  (window as WindowWithQueue).initWidgetPlatform = (
    config: ChatWidgetConfig,
  ) => {
    (window as WindowWithQueue)._chatWidgetQueue?.push(config);
  };
}

// Add backdrop creation function
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

function initWidgetPlatform(config: ChatWidgetConfig) {
  // Validate that either id or api is provided
  if (!config.id && !config.api) {
    console.error(
      "Either Widget ID or API URL is required to initialize the chat widget",
    );
    return;
  }

  // Merge provided config with defaults
  const finalConfig = { ...defaultConfig, ...config };

  const button = document.createElement("button");
  button.id = "widgetplatform-chat-widget-button";

  // Calculate position styles based on buttonPosition
  const positionStyles = {
    "bottom-right": `bottom: ${finalConfig.buttonMargin}; right: ${finalConfig.buttonMargin};`,
    "bottom-left": `bottom: ${finalConfig.buttonMargin}; left: ${finalConfig.buttonMargin};`,
    "top-right": `top: ${finalConfig.buttonMargin}; right: ${finalConfig.buttonMargin};`,
    "top-left": `top: ${finalConfig.buttonMargin}; left: ${finalConfig.buttonMargin};`,
  }[finalConfig.buttonPosition!];

  button.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${finalConfig.buttonSize};
    height: ${finalConfig.buttonSize};
    border: none;
    background-color: ${finalConfig.buttonBackgroundColor};
    color: ${finalConfig.buttonColor};
    border-radius: 9999px;
    box-shadow: 0 2px 8px 0 rgba(0,0,0,.2);
    position: fixed;
    ${positionStyles}
    z-index: 50;
    transition: background-color 0.3s, opacity 0.3s, transform 0.2s ease;
    -webkit-font-smoothing: antialiased;
    cursor: pointer;
    transform: scale(1);
  `;

  // Add hover event listeners
  button.addEventListener("mouseenter", () => {
    button.style.transform = "scale(1.05)";
  });

  button.addEventListener("mouseleave", () => {
    button.style.transform = "scale(1)";
  });

  button.innerHTML = `
    ${
      finalConfig.svgIcon
        ? finalConfig.svgIcon
        : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>`
    }`;

  button.onclick = () => toggleChat(finalConfig);
  document.body.appendChild(button);
}

function createIframe(config: ChatWidgetConfig) {
  const iframe = document.createElement("iframe");
  iframe.id = IFRAME_ID;

  // Calculate styles based on display type
  let positionStyles = "";
  let dimensions = "";

  if (config.displayType === "popup") {
    positionStyles = {
      "bottom-right": `bottom: ${config.buttonMargin}; right: ${config.buttonMargin};`,
      "bottom-left": `bottom: ${config.buttonMargin}; left: ${config.buttonMargin};`,
      "top-right": `top: ${config.buttonMargin}; right: ${config.buttonMargin};`,
      "top-left": `top: ${config.buttonMargin}; left: ${config.buttonMargin};`,
    }[config.buttonPosition!];

    dimensions = `
      width: ${config.iframeWidth};
      height: ${config.iframeHeight};
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 100px);
    `;
  } else if (config.displayType === "modal") {
    positionStyles = `
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) translateY(20px);
    `;

    dimensions = `
      width: min(${config.iframeWidth}, 90vw);
      height: min(${config.iframeHeight}, 90vh);
    `;
  }

  iframe.style.cssText = `
    box-sizing: border-box;
    position: fixed;
    ${positionStyles}
    ${dimensions}
    border: none;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 999999;
    opacity: 0;
    transition: opacity 0.3s, transform 0.3s;
  `;

  iframe.src = config.id
    ? `${WIDGET_IFRAME_ENDPOINT}?id=${config.id}`
    : config.api!;

  document.body.appendChild(iframe);
  return iframe;
}

// Update toggleChat to handle modal display
function toggleChat(config: ChatWidgetConfig) {
  let iframe = document.getElementById(IFRAME_ID) as HTMLIFrameElement;
  const button = document.getElementById(
    "openai-chat-widget-button",
  ) as HTMLButtonElement;
  let backdrop = document.getElementById(
    "openai-chat-widget-backdrop",
  ) as HTMLDivElement;

  if (!iframe) {
    iframe = createIframe(config);
    if (config.displayType === "modal" && config.modalBackdrop) {
      backdrop = createBackdrop();
    }

    setTimeout(() => {
      iframe.style.opacity = "1";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(0)";
      } else if (config.displayType === "modal") {
        iframe.style.transform = "translate(-50%, -50%)";
        if (backdrop) backdrop.style.opacity = "1";
      }
      button.style.opacity = "0";
    }, 10);
  } else {
    if (iframe.style.opacity === "0") {
      iframe.style.opacity = "1";
      iframe.style.pointerEvents = "auto";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(0)";
      } else if (config.displayType === "modal") {
        iframe.style.transform = "translate(-50%, -50%)";
        if (backdrop) backdrop.style.opacity = "1";
      }
      button.style.opacity = "0";

      if (config.displayType === "modal" && config.modalBackdrop) {
        backdrop = createBackdrop();
      }
    } else {
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      if (config.displayType === "popup") {
        iframe.style.transform = "translateY(20px)";
      } else if (config.displayType === "modal") {
        iframe.style.transform = "translate(-50%, -50%) translateY(20px)";
        if (backdrop) backdrop.style.opacity = "0";
      }
      button.style.opacity = "1";

      // Remove backdrop after animation
      if (backdrop) {
        setTimeout(() => {
          backdrop.remove();
        }, 300);
      }
    }
  }
}

// Update message event listener to handle backdrop click
let currentConfig: ChatWidgetConfig | null = null;

window.addEventListener("message", (event) => {
  if (event.data === "close-chat" && currentConfig) {
    toggleChat(currentConfig);
  }
});

// Add click handler for backdrop
document.addEventListener("click", (event) => {
  const backdrop = document.getElementById("openai-chat-widget-backdrop");
  if (event.target === backdrop && currentConfig) {
    toggleChat(currentConfig);
  }
});

// Make initWidgetPlatform available globally with proper typing
declare global {
  interface Window {
    initWidgetPlatform: (config: ChatWidgetConfig) => void;
  }
}

window.initWidgetPlatform = initWidgetPlatform;

// At the end of the file, process any queued calls
function processQueue() {
  const win = window as WindowWithQueue;
  const queue = win._chatWidgetQueue || [];

  win.initWidgetPlatform = (config: ChatWidgetConfig) => {
    if (!config.id && !config.api) {
      console.error(
        "Either Widget ID or API URL is required to initialize the chat widget",
      );
      return;
    }
    const finalConfig = { ...defaultConfig, ...config };
    currentConfig = finalConfig;
    initWidgetPlatform(finalConfig);
  };

  // Process any queued calls
  while (queue.length > 0) {
    const config = queue.shift();
    if (config) {
      win.initWidgetPlatform(config);
    }
  }
}

// Call processQueue when the script loads
processQueue();

// Dispatch event when script is fully loaded
window.dispatchEvent(new Event("chatWidgetLoaded"));
