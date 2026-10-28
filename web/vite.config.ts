import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, Vite serves the UI on :5173 and forwards /api to the Node server on :8787.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
