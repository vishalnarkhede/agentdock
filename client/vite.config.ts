import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { OPTIMIZE_INCLUDE } from "./vite.deps";

const serverPort = process.env.SERVER_PORT || "4800";

export default defineConfig({
  plugins: [react(), basicSsl()],
  optimizeDeps: { include: OPTIMIZE_INCLUDE },
  server: {
    port: parseInt(process.env.VITE_PORT || "5173"),
    host: true,
    allowedHosts: "all",
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": {
        target: `http://localhost:${serverPort}`,
        ws: true,
      },
    },
  },
});
