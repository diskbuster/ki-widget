(function(){"use strict";const r="widgetplatform-widget-oa-iframe",p="https://botapp.lab49.de/index.html",s={buttonPosition:"bottom-right",buttonColor:"#ffffff",buttonBackgroundColor:"#2563eb",buttonSize:"3.5rem",buttonMargin:"1rem",iframeWidth:"400px",iframeHeight:"600px",displayType:"popup",modalBackdrop:!0};window._chatWidgetQueue=window._chatWidgetQueue||[],window.initWidgetPlatform||(window.initWidgetPlatform=t=>{var e;(e=window._chatWidgetQueue)==null||e.push(t)});function d(){const t=document.createElement("div");return t.id="openai-chat-widget-backdrop",t.style.cssText=`
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 999998;
    opacity: 0;
    transition: opacity 0.3s;
  `,document.body.appendChild(t),t}function l(t){if(!t.id&&!t.api){console.error("Either Widget ID or API URL is required to initialize the chat widget");return}const e={...s,...t},o=document.createElement("button");o.id="widgetplatform-chat-widget-button";const i={"bottom-right":`bottom: ${e.buttonMargin}; right: ${e.buttonMargin};`,"bottom-left":`bottom: ${e.buttonMargin}; left: ${e.buttonMargin};`,"top-right":`top: ${e.buttonMargin}; right: ${e.buttonMargin};`,"top-left":`top: ${e.buttonMargin}; left: ${e.buttonMargin};`}[e.buttonPosition];o.style.cssText=`
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${e.buttonSize};
    height: ${e.buttonSize};
    border: none;
    background-color: ${e.buttonBackgroundColor};
    color: ${e.buttonColor};
    border-radius: 9999px;
    box-shadow: 0 2px 8px 0 rgba(0,0,0,.2);
    position: fixed;
    ${i}
    z-index: 50;
    transition: background-color 0.3s, opacity 0.3s, transform 0.2s ease;
    -webkit-font-smoothing: antialiased;
    cursor: pointer;
    transform: scale(1);
  `,o.addEventListener("mouseenter",()=>{o.style.transform="scale(1.05)"}),o.addEventListener("mouseleave",()=>{o.style.transform="scale(1)"}),o.innerHTML=`
    ${e.svgIcon?e.svgIcon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>`}`,o.onclick=()=>a(e),document.body.appendChild(o)}function u(t){const e=document.createElement("iframe");e.id=r;let o="",i="";return t.displayType==="popup"?(o={"bottom-right":`bottom: ${t.buttonMargin}; right: ${t.buttonMargin};`,"bottom-left":`bottom: ${t.buttonMargin}; left: ${t.buttonMargin};`,"top-right":`top: ${t.buttonMargin}; right: ${t.buttonMargin};`,"top-left":`top: ${t.buttonMargin}; left: ${t.buttonMargin};`}[t.buttonPosition],i=`
      width: ${t.iframeWidth};
      height: ${t.iframeHeight};
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 100px);
    `):t.displayType==="modal"&&(o=`
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) translateY(20px);
    `,i=`
      width: min(${t.iframeWidth}, 90vw);
      height: min(${t.iframeHeight}, 90vh);
    `),e.style.cssText=`
    box-sizing: border-box;
    position: fixed;
    ${o}
    ${i}
    border: none;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 999999;
    opacity: 0;
    transition: opacity 0.3s, transform 0.3s;
  `,e.src=t.id?`${p}?id=${t.id}`:t.api,document.body.appendChild(e),e}function a(t){let e=document.getElementById(r);const o=document.getElementById("openai-chat-widget-button");let i=document.getElementById("openai-chat-widget-backdrop");e?e.style.opacity==="0"?(e.style.opacity="1",e.style.pointerEvents="auto",t.displayType==="popup"?e.style.transform="translateY(0)":t.displayType==="modal"&&(e.style.transform="translate(-50%, -50%)",i&&(i.style.opacity="1")),o.style.opacity="0",t.displayType==="modal"&&t.modalBackdrop&&(i=d())):(e.style.opacity="0",e.style.pointerEvents="none",t.displayType==="popup"?e.style.transform="translateY(20px)":t.displayType==="modal"&&(e.style.transform="translate(-50%, -50%) translateY(20px)",i&&(i.style.opacity="0")),o.style.opacity="1",i&&setTimeout(()=>{i.remove()},300)):(e=u(t),t.displayType==="modal"&&t.modalBackdrop&&(i=d()),setTimeout(()=>{e.style.opacity="1",t.displayType==="popup"?e.style.transform="translateY(0)":t.displayType==="modal"&&(e.style.transform="translate(-50%, -50%)",i&&(i.style.opacity="1")),o.style.opacity="0"},10))}let n=null;window.addEventListener("message",t=>{t.data==="close-chat"&&n&&a(n)}),document.addEventListener("click",t=>{const e=document.getElementById("openai-chat-widget-backdrop");t.target===e&&n&&a(n)}),window.initWidgetPlatform=l;function m(){const t=window,e=t._chatWidgetQueue||[];for(t.initWidgetPlatform=o=>{if(!o.id&&!o.api){console.error("Either Widget ID or API URL is required to initialize the chat widget");return}const i={...s,...o};n=i,l(i)};e.length>0;){const o=e.shift();o&&t.initWidgetPlatform(o)}}m(),window.dispatchEvent(new Event("chatWidgetLoaded"))})();
