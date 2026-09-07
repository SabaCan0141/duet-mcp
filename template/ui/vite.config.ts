import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { portFor } from "duet-mcp/wire";

// Match the directory name to app.id when copying or renaming the template.
const appId = path.basename(path.resolve(__dirname, ".."));

// Use the same port derivation as the server.
const target = `http://127.0.0.1:${portFor(appId)}`;

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/blob": { target, changeOrigin: true },
    },
  },
});
