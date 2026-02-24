import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const serverPort = process.env.SERVER_PORT || "4800";

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: parseInt(process.env.VITE_PORT || "5173"),
    host: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": {
        target: `http://localhost:${serverPort}`,
        ws: true,
      },
    },
  },
});
