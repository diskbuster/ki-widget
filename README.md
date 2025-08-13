# Widget Platform: OpenAI Assistants Chat Widget

This is a simple chat widget for OpenAI Assistants. It is built with React, Vite, and Tailwind CSS.

If you want, you can use this widget as a starting point to build your own chat widget.

Also exist as a React component for easily adding a Widget for OpenAI Assistants from WidgetPlatform.com to your website: [https://github.com/widgetplatform/widget-oa-react/](https://github.com/widgetplatform/widget-oa-react/).

[See DEMO on widgetplatform.com](https://widgetplatform.com) 

## Preview

![Preview OpenAI Assistant Widget](https://widgetplatform.com/images/chat-widget-preview.png)

## Links
- [Documentation](https://docs.widgetplatform.com)
- [NPM](https://www.npmjs.com/package/widget-oa-react)
- [Website](https://widgetplatform.com)

## Features

- 🚀 Easy to integrate
- 🔄 Single instance across page navigation
- 📱 Responsive design
- 🎨 Customizable appearance
- 📦 Lightweight
- 💪 TypeScript support

## Getting Started

1. Clone the repository
2. Run `npm install` to install the dependencies
3. Run `npm run build` to start the development server

Modify the `env.example` file to add your OpenAI API key and Assistant ID and rename it to `.env`.

This creates 3 main components:

- `server`: The server for communication between the widget and the OpenAI API.
- `app`: The main React application. This app you need as a target for iframe inside the widget.
- `widget`: The javascript snippet which create iframe to inject them in your website.


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
<script>
    // Widget configuration
    const widgetConfig = {
        id: '2c8159ef-aaaa-bbbb-97eb-44ff87d42387', //if you use widgetplatform.com
        //api: 'https://your-website.com/oa-widget/app/index.html', //if you don't use widgetplatform.com and you host the app yourself
        buttonMargin: '1rem',
        displayType: 'popup',
        buttonBackgroundColor: '#2563eb',
        buttonColor: '#fff'
    };
    const script = document.createElement('script');
    script.src = "https://your-website.com/widget.iife.js";
    script.async = 1;
    script.defer = 1;
    script.onload = function () {
        initWidgetPlatform(widgetConfig);
    };
    document.head.appendChild(script);
</script>
```

If you don't use widgetplatform.com (where you need to provide `id`) then you have to provide `api` instead. In this case, you need to host the `dist/app` folder in your website and use the right address to load it.

For complete configuration options, please refer to the `widget/inject.ts` or check online documentation: https://docs.widgetplatform.com/widget-oa/js-widget-configuration

