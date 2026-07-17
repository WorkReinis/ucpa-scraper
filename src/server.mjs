// node src/server.mjs -> serves the API plus the built frontend, once you've
// run `npm run build` in web/ (single deployable process, one port). For
// day-to-day dev with hot reload and no build step, use `npm run dev`
// instead (web/dev-server.mjs) -- same API routes (src/apiRoutes.mjs), Vite
// in middleware mode serving the frontend instead of this static dist dir.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiApp } from "./apiRoutes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createApiApp();

// Serve the built frontend, if it's been built (npm run build inside web/).
const distDir = path.join(__dirname, "..", "web", "dist");
app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(distDir, "index.html"), (err) => { if (err) next(); });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`API + site on http://localhost:${PORT}`));
