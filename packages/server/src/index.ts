import express from "express";
import { env } from "./env.js";
import { registerMcp } from "./mcp/tools.js";

const app = express();
app.use(express.json());

// Health check (usado por el ALB / target group).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "lpms-facade", ts: new Date().toISOString() });
});

// Endpoint MCP (Streamable HTTP) — stub por ahora (ver mcp/tools.ts).
registerMcp(app);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`LPMS facade escuchando en :${env.PORT} (${env.NODE_ENV})`);
});
