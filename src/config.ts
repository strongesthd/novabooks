import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1),
  DB_SSL: z.enum(["true", "false"]).default("false"),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(30).default(12),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  TELEGRAM_BOT_API_BASE_URL: z.string().url().default("https://api.telegram.org"),
  ZALO_API_BASE_URL: z.string().url().default("https://openapi.zalo.me"),
  TTS_API_KEY: z.string().optional().default(""),
  TTS_VOICE_ID: z.string().optional().default(""),
  DAILY_REPORT_CRON: z.string().default("0 18 * * *")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const config = parsed.data;
