import { z } from 'zod';

/**
 * Environment variables every service needs. A service extends this with its own
 * requirements via {@link loadEnv}.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Validates `process.env` against the base schema merged with a service's own.
 *
 * Fails loudly: on the first invalid or missing variable this throws with every
 * offending variable named, so a misconfigured container stops at boot rather
 * than failing later under load. Never logs a value — only the variable name.
 */
export function loadEnv<S extends z.ZodRawShape>(
  serviceSchema: S = {} as S,
  source: NodeJS.ProcessEnv = process.env,
): BaseEnv & z.infer<z.ZodObject<S>> {
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

  return result.data as BaseEnv & z.infer<z.ZodObject<S>>;
}
