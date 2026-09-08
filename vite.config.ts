import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/ui/client"),
  base: "/ui/",
  define: { global: "globalThis" },
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^buffer$/, replacement: resolve(import.meta.dirname, "node_modules/buffer/index.js") },
    ],
    extensions: [".web.tsx", ".web.ts", ".web.jsx", ".web.js", ".tsx", ".ts", ".jsx", ".js"],
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/ui/client"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/ui/client/shell.html"),
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "chunk-[name].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "app.css" : "asset-[name][extname]",
      },
    },
  },
});
