import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { config } from "./config";

const key = Buffer.from(config.ENCRYPTION_KEY, "hex");

export function hashWebhookKey(keyText: string): Buffer {
  return createHash("sha256").update(keyText).digest();
}

export function encryptJson(value: Record<string, unknown>): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptJson(ciphertext: Buffer): Record<string, unknown> {
  if (ciphertext.length < 29) throw new Error("Stored channel credential is invalid");
  const iv = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(12, 28);
  const body = ciphertext.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored channel credential payload is invalid");
  }
  return parsed as Record<string, unknown>;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
