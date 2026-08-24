import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain HTTP for phones. The dev cert is self-signed with CN=example.org, which
// iOS Safari will not let you click past on an IP address.
const serverPort = process.env.SERVER_PORT || "4900";

export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.VITE_PORT || "5290"),
    host: true,
    allowedHosts: "all",
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": { target: `http://localhost:${serverPort}`, ws: true },
    },
  },
});
