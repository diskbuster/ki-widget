import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  root: "src",
  plugins: [react()],
  server: {
    allowedHosts: ["botserver.lab49.de"],
  },
  build: {
    outDir: "../dist/app",
    sourcemap: false,
    minify: "terser",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          ui: ["lucide-react"],
        },
      },
    },
  },
});
