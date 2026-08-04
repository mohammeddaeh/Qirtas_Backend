import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Session idle timeout in minutes — a session with no request in this
   * window is treated as expired (core/middleware/auth.ts). Default is a
   * placeholder (7 days); users_roles.md does not mandate a specific value —
   * tune via env, not a business-rule decision baked into code.
   */
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10080), // 7 days
  /**
   * Comma-separated browser origins allowed to call this API, e.g.
   * `https://admin.qirtas.sy,https://qirtas.sy`.
   *
   * Empty (the default) means **no browser origin is allowed** — deliberately
   * strict rather than open. The mobile client is unaffected either way: CORS
   * is a browser mechanism and native HTTP clients ignore it entirely. So a
   * wide-open policy bought nothing and cost everything the moment a web build
   * or browser admin panel appears (production_readiness.md §A3).
   */
  ALLOWED_ORIGINS: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
