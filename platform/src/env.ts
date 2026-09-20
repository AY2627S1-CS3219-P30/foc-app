import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Read `.env` from the working directory if one exists, so a teammate who has
// copied `.env.example` gets those values without exporting anything into
// their shell. Real environment variables always win — dotenv never overwrites
// what the container or CI already set.
loadDotenv({ quiet: true });

/**
 * Environment variables every service needs. A service extends this with its own
 * requirements via {@link loadEnv}.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Comma-separated browser origins allowed to call this service. Defaults to
   * the local web app. Never widen this to `*` — these endpoints carry
   * credentials once USR-02 lands (US-NFR1.1.2).
   */
  CORS_ORIGINS: z.string().min(1).default('http://localhost:3000'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Validates `process.env` against the base schema merged with a service's own.
 *
 * Fails loudly: on the first invalid or missing variable this throws with every
 * offending variable named, so a misconfigured container stops at boot rather
 * than failing later under load. Never logs a value — only the variable name.
 */
export function loadEnv<S extends z.ZodRawShape = Record<never, never>>(
  serviceSchema: S = {} as S,
  source: NodeJS.ProcessEnv = process.env,
): BaseEnv & { [K in keyof S]: z.output<S[K]> } {
  const schema = baseEnvSchema.extend(serviceSchema);
  const result = schema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return `  - ${name}: ${issue.message}`;
      })
      .sort();
    throw new Error(
      `Invalid environment configuration. The service cannot start.\n` +
        `${problems.join('\n')}\n` +
        `Set these in your .env file or container environment. See .env.example.`,
    );
  }

  // A mapped type rather than `z.infer<z.ZodObject<S>>`: for an empty schema
  // the latter widens to `Record<string, never>`, which makes every base key
  // that TypeScript cannot see resolve to `never`. Cast through `unknown`
  // because zod's inferred shape for the extended schema is structurally
  // equivalent but not assignable.
  return result.data as unknown as BaseEnv & { [K in keyof S]: z.output<S[K]> };
}
