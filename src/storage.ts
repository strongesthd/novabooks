import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function validateDocument(buffer: Buffer, mimeType: string): void {
  if (!allowedTypes.has(mimeType)) throw new DocumentValidationError("Chỉ chấp nhận JPEG, PNG, WebP hoặc PDF");
  const validMagic = mimeType === "image/jpeg"
    ? buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : mimeType === "image/png"
      ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/webp"
        ? buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"
        : buffer.toString("ascii", 0, 5) === "%PDF-";
  if (!validMagic) throw new DocumentValidationError("Nội dung tệp không khớp định dạng khai báo");
}

export async function saveDocument(tenantId: string, buffer: Buffer, mimeType: string): Promise<{
  storageKey: string;
  sha256: Buffer;
}> {
  validateDocument(buffer, mimeType);
  const extension = mimeType === "application/pdf" ? ".pdf"
    : mimeType === "image/png" ? ".png"
      : mimeType === "image/webp" ? ".webp" : ".jpg";
  const storageKey = path.join(tenantId, `${randomUUID()}${extension}`);
  const fullPath = path.resolve(config.UPLOAD_DIR, storageKey);
  const root = path.resolve(config.UPLOAD_DIR);
  if (!fullPath.startsWith(`${root}${path.sep}`)) throw new Error("Invalid private storage path");
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer, { flag: "wx", mode: 0o600 });
  return { storageKey, sha256: createHash("sha256").update(buffer).digest() };
}

export async function loadDocument(storageKey: string): Promise<Buffer> {
  const fullPath = path.resolve(config.UPLOAD_DIR, storageKey);
  const root = path.resolve(config.UPLOAD_DIR);
  if (!fullPath.startsWith(`${root}${path.sep}`)) throw new Error("Invalid private storage path");
  return readFile(fullPath);
}

export class DocumentValidationError extends Error {
  readonly status = 415;
}
