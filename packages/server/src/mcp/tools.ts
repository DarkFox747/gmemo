import type { Express, Request, Response } from "express";

/**
 * Contrato de las tools del facade — ver docs/artefactos/lpms_facade_contract_v1.md.
 *
 * Superficie del agente:
 *  - Lectura: recall, get_memory, get_context  (+ tools de grafo, aparte)
 *  - Escritura a staging: remember, list_staged, discard_staged
 *  - NO expuestas: save/update/delete de main ni promote (pipeline / Web UI)
 *
 * Estos son STUBS. La implementación real (transporte MCP del SDK, auth JWT + RBAC,
 * acceso a datos vía Prisma) se agrega en los próximos incrementos.
 */

const NOT_IMPLEMENTED = { error: "not_implemented" as const };

export function registerMcp(app: Express): void {
  // Placeholder del endpoint MCP (Streamable HTTP). Se reemplaza por el
  // transporte real del @modelcontextprotocol/sdk en el próximo incremento.
  app.post("/mcp", (_req: Request, res: Response) => {
    res.status(501).json(NOT_IMPLEMENTED);
  });
}

/** Firmas de las tools (según el contrato). Sin implementar todavía. */
export const tools = {
  recall: async (): Promise<never> => {
    throw new Error("not_implemented: recall");
  },
  get_memory: async (): Promise<never> => {
    throw new Error("not_implemented: get_memory");
  },
  get_context: async (): Promise<never> => {
    throw new Error("not_implemented: get_context");
  },
  remember: async (): Promise<never> => {
    throw new Error("not_implemented: remember");
  },
  list_staged: async (): Promise<never> => {
    throw new Error("not_implemented: list_staged");
  },
  discard_staged: async (): Promise<never> => {
    throw new Error("not_implemented: discard_staged");
  },
};
