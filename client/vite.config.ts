import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const serverPort = process.env.SERVER_PORT || "4800";
const host = process.env.AGENTDOCK_HOST || "127.0.0.1";
const exposeNetwork = host !== "127.0.0.1" && host !== "localhost";
const proxyHost = host === "localhost" || host === "0.0.0.0" ? "127.0.0.1" : host;

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: parseInt(process.env.VITE_PORT || "5173"),
    host,
    ...(exposeNetwork ? { allowedHosts: "all" } : {}),
    proxy: {
      "/api": `http://${proxyHost}:${serverPort}`,
      "/ws": {
        target: `http://${proxyHost}:${serverPort}`,
        ws: true,
      },
    },
  },
});
