(function(){"use strict";const r="widgetplatform-widget-oa-iframe",p="https://botapp.lab49.de/index.html",s={buttonPosition:"bottom-right",buttonColor:"#ffffff",buttonBackgroundColor:"#2563eb",buttonSize:"3.5rem",buttonMargin:"1rem",iframeWidth:"400px",iframeHeight:"600px",displayType:"popup",modalBackdrop:!0};window._chatWidgetQueue=window._chatWidgetQueue||[],window.initWidgetPlatform||(window.initWidgetPlatform=e=>{var t;(t=window._chatWidgetQueue)==null||t.push(e)});function d(){const e=document.createElement("div");return e.id="openai-chat-widget-backdrop",e.style.cssText=`
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0.5);
    z-index: 999998;
    opacity: 0;
    transition: opacity 0.3s;
  `,document.body.appendChild(e),e}let n=null;function l(e){if(!e.id&&!e.api){console.error("Either Widget ID or API URL is required to initialize the chat widget");return}const t={...s,...e};n=t;const o=document.createElement("button");o.id="widgetplatform-chat-widget-button";const i={"bottom-right":`bottom: ${t.buttonMargin}; right: ${t.buttonMargin};`,"bottom-left":`bottom: ${t.buttonMargin}; left: ${t.buttonMargin};`,"top-right":`top: ${t.buttonMargin}; right: ${t.buttonMargin};`,"top-left":`top: ${t.buttonMargin}; left: ${t.buttonMargin};`}[t.buttonPosition];o.style.cssText=`
    display: flex; align-items: center; justify-content: center;
    width: ${t.buttonSize}; height: ${t.buttonSize};
    border: none; background-color: ${t.buttonBackgroundColor};
    color: ${t.buttonColor}; border-radius: 9999px;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
    position: fixed; ${i}; z-index: 50;
    transition: background-color .3s, opacity .3s, transform .2s ease;
    -webkit-font-smoothing: antialiased; cursor: pointer; transform: scale(1);
  `,o.addEventListener("mouseenter",()=>{o.style.transform="scale(1.05)"}),o.addEventListener("mouseleave",()=>{o.style.transform="scale(1)"}),o.innerHTML=t.svgIcon?t.svgIcon:`<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
         stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
       </svg>`,o.onclick=()=>a(t),document.body.appendChild(o)}function u(e){const t=document.createElement("iframe");t.id=r;let o="",i="";return e.displayType==="popup"?(o={"bottom-right":`bottom: ${e.buttonMargin}; right: ${e.buttonMargin};`,"bottom-left":`bottom: ${e.buttonMargin}; left: ${e.buttonMargin};`,"top-right":`top: ${e.buttonMargin}; right: ${e.buttonMargin};`,"top-left":`top: ${e.buttonMargin}; left: ${e.buttonMargin};`}[e.buttonPosition],i=`
      width: ${e.iframeWidth};
      height: ${e.iframeHeight};
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 100px);
    `):(o=`
      top: 50%; left: 50%; transform: translate(-50%, -50%) translateY(20px);
    `,i=`
      width: min(${e.iframeWidth}, 90vw);
      height: min(${e.iframeHeight}, 90vh);
    `),t.style.cssText=`
    box-sizing: border-box; position: fixed; ${o} ${i}
    border: none; border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,.15);
    z-index: 999999; opacity: 0;
    transition: opacity .3s, transform .3s;
  `,t.src=e.api?e.api:`${p}?id=${e.id}`,document.body.appendChild(t),t}function a(e){let t=document.getElementById(r);const o=document.getElementById("widgetplatform-chat-widget-button");let i=document.getElementById("openai-chat-widget-backdrop");t?t.style.opacity==="0"?(t.style.opacity="1",t.style.pointerEvents="auto",e.displayType==="popup"?t.style.transform="translateY(0)":(t.style.transform="translate(-50%, -50%)",i&&(i.style.opacity="1")),o&&(o.style.opacity="0"),e.displayType==="modal"&&e.modalBackdrop&&(i=d())):(t.style.opacity="0",t.style.pointerEvents="none",e.displayType==="popup"?t.style.transform="translateY(20px)":(t.style.transform="translate(-50%, -50%) translateY(20px)",i&&(i.style.opacity="0")),o&&(o.style.opacity="1"),i&&setTimeout(()=>i.remove(),300)):(t=u(e),e.displayType==="modal"&&e.modalBackdrop&&(i=d()),setTimeout(()=>{t.style.opacity="1",e.displayType==="popup"?t.style.transform="translateY(0)":(t.style.transform="translate(-50%, -50%)",i&&(i.style.opacity="1")),o&&(o.style.opacity="0")},10))}window.addEventListener("message",e=>{e.data==="close-chat"&&n&&a(n)}),document.addEventListener("click",e=>{const t=document.getElementById("openai-chat-widget-backdrop");e.target===t&&n&&a(n)}),window.initWidgetPlatform=l;function c(){const e=window,t=e._chatWidgetQueue||[];for(e.initWidgetPlatform=o=>{if(!o.id&&!o.api){console.error("Either Widget ID or API URL is required to initialize the chat widget");return}const i={...s,...o};n=i,l(i)};t.length>0;){const o=t.shift();o&&e.initWidgetPlatform(o)}}c(),window.dispatchEvent(new Event("chatWidgetLoaded"))})();
