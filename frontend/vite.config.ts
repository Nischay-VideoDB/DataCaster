import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { workflow } from "workflow/vite"

export default defineConfig({
  plugins: [react(), tailwindcss(), nitro(), workflow({ runtime: "nodejs24.x" })],
  nitro: {
    serverDir: "./",
    vercel: { functions: { maxDuration: 300 } },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: { port: 3000 },
})
