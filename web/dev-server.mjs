// node web/dev-server.mjs (or `npm run dev` from the repo root) -> one
// process, one port: the real API (src/apiRoutes.mjs) plus the frontend
// served through Vite in middleware mode, so edits to web/src hot-reload
// same as `vite` on its own would. No build step, and no separate Vite port
// to keep in sync with the API -- that's what this replaces (the old
// two-window `npm run server` + `npm run web` setup).
//
// For the single-file production build instead, see README ("single
// deployable process") -- that's still `npm run build --prefix web` then
// `npm run server`, unchanged.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiApp } from "../src/apiRoutes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = createApiApp();

// Registered after the /api/* routes above, so Express matches those first
// and Vite only ever sees requests nothing else claimed.
const vite = await createViteServer({
  root: __dirname,
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`UCPA Tracker (dev, hot reload) on http://localhost:${PORT}`));
