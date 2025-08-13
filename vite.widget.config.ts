import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'widget/inject.ts',
      name: 'ChatWidget',
      fileName: 'widget',
      formats: ['iife'],
    },
    outDir: 'dist/widget',
  },
});