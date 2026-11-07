import { z } from "zod";

/**
 * Configuración del facade, validada al arranque (fail-fast).
 * Los campos de Cognito tienen default vacío para permitir levantar /health
 * sin configuración completa durante el desarrollo del esqueleto.
 */
const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().default(""),
  COGNITO_REGION: z.string().default(""),
  COGNITO_USER_POOL_ID: z.string().default(""),
  ALLOWED_CLIENT_IDS: z.string().default(""),
  BEDROCK_REGION: z.string().optional(),
});

export const env = schema.parse(process.env);

/** app clients de Cognito autorizados a usar el facade. */
export const allowedClientIds = new Set(
  env.ALLOWED_CLIENT_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
