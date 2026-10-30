import { randomBytes } from "node:crypto";
import { config } from "./config";
import { encryptJson, hashWebhookKey } from "./crypto";
import { TenantTransaction } from "./db";
import { AuthContext } from "./types";
import { channelSchema } from "./validation";

type Channel = {
  id: string;
  tenant_id: string;
  provider: "telegram" | "zalo_oa";
  external_account_id: string | null;
  display_name: string | null;
  credentials_ciphertext: Buffer;
  config: Record<string, unknown>;
  status: string;
};

export async function connectChannel(
  tx: TenantTransaction,
  auth: AuthContext,
  rawInput: unknown
): Promise<{
  channelId: string;
  provider: string;
  status: string;
  webhookUrl: string;
  telegramSetup?: { token: string; secret: string };
}> {
  const input = channelSchema.parse(rawInput);
  const routeKey = randomBytes(32).toString("base64url");
  const webhookSecret = randomBytes(32).toString("base64url");
  let externalAccountId: string;
  let displayName: string;
  let credentials: Record<string, unknown>;
  let channelConfig: Record<string, unknown>;

  if (input.provider === "telegram") {
    const botInfo = await telegramRequest(input.botToken, "getMe", {});
    if (!botInfo.ok || !botInfo.result?.id) throw new Error("Telegram Bot token không hợp lệ");
    externalAccountId = String(botInfo.result.id);
    displayName = `@${String(botInfo.result.username ?? "telegram-bot")}`;
    credentials = { token: input.botToken, webhookSecret, routeKey };
    channelConfig = { chatId: input.chatId };
  } else {
    externalAccountId = input.oaId;
    displayName = `Zalo OA ${input.oaId}`;
    credentials = {
      accessToken: input.accessToken,
      appSecret: input.appSecret,
      routeKey
    };
    channelConfig = { recipientId: input.recipientId };
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO tenant_channels
       (tenant_id, provider, external_account_id, display_name, credentials_ciphertext,
        encryption_key_version, webhook_key_hash, config, status)
     VALUES ($1, $2, $3, $4, $5, 'v1', $6, $7, 'active')
     RETURNING id`,
    [
      auth.tenantId, input.provider, externalAccountId, displayName,
      encryptJson(credentials), hashWebhookKey(routeKey), JSON.stringify(channelConfig)
    ]
  );
  const channelId = inserted.rows[0]?.id;
  if (!channelId) throw new Error("Channel insert returned no identifier");
  await tx.query(
    `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id)
     VALUES ($1, $2, 'channel.connected', 'tenant_channel', $3)`,
    [auth.tenantId, auth.userId, channelId]
  );
  const routeProvider = input.provider === "zalo_oa" ? "zalo" : "telegram";
  const webhookUrl = `${config.APP_BASE_URL}/webhooks/${routeProvider}/${routeKey}`;
  return {
    channelId,
    provider: input.provider,
    status: "active",
    webhookUrl,
    ...(input.provider === "telegram" ? { telegramSetup: { token: input.botToken, secret: webhookSecret } } : {})
  };
}

export async function registerTelegramWebhook(
  token: string,
  secret: string,
  webhookUrl: string
): Promise<void> {
  const result = await telegramRequest(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"]
  });
  if (!result.ok) throw new Error("Telegram từ chối đăng ký webhook; kiểm tra URL HTTPS và cấu hình Bot");
}

export async function listChannels(tx: TenantTransaction): Promise<Array<Record<string, unknown>>> {
  const result = await tx.query(
    `SELECT id, provider, external_account_id, display_name, status, last_verified_at, created_at
     FROM tenant_channels WHERE tenant_id = current_setting('app.tenant_id')::uuid
     ORDER BY created_at DESC`
  );
  return result.rows;
}

export async function getChannel(
  tenantId: string,
  channelId: string,
  tx: TenantTransaction
): Promise<Channel | null> {
  const result = await tx.query<Channel>(
    "SELECT * FROM tenant_channels WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
    [tenantId, channelId]
  );
  return result.rows[0] ?? null;
}

export async function activeChannels(tx: TenantTransaction): Promise<Channel[]> {
  const result = await tx.query<Channel>(
    "SELECT * FROM tenant_channels WHERE tenant_id = current_setting('app.tenant_id')::uuid AND status = 'active'"
  );
  return result.rows;
}

export async function sendText(channel: Channel, secrets: Record<string, unknown>, text: string): Promise<void> {
  if (channel.provider === "telegram") {
    const token = requireString(secrets.token, "Telegram token");
    const chatId = requireString(channel.config.chatId, "Telegram chat ID");
    const result = await telegramRequest(token, "sendMessage", { chat_id: chatId, text });
    if (!result.ok) throw new Error(`Telegram send failed: ${String(result.description ?? "provider error")}`);
    return;
  }

  const accessToken = requireString(secrets.accessToken, "Zalo access token");
  const recipientId = requireString(channel.config.recipientId, "Zalo recipient ID");
  const response = await fetch(`${config.ZALO_API_BASE_URL}/v3.0/oa/message/cs`, {
    method: "POST",
    headers: { "content-type": "application/json", access_token: accessToken },
    body: JSON.stringify({ recipient: { user_id: recipientId }, message: { text } }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Zalo send failed with HTTP ${response.status}`);
  const body = await response.json() as { error?: number; message?: string };
  if (body.error && body.error !== 0) throw new Error(`Zalo send failed: ${body.message ?? body.error}`);
}

export async function sendTelegramVoice(
  channel: Channel,
  secrets: Record<string, unknown>,
  audio: Buffer
): Promise<void> {
  if (channel.provider !== "telegram") return;
  const token = requireString(secrets.token, "Telegram token");
  const chatId = requireString(channel.config.chatId, "Telegram chat ID");
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("voice", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "daily-report.mp3");
  const response = await fetch(`${config.TELEGRAM_BOT_API_BASE_URL}/bot${token}/sendVoice`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Telegram voice delivery failed with HTTP ${response.status}`);
  const body = await response.json() as { ok?: boolean; description?: string };
  if (!body.ok) throw new Error(`Telegram voice delivery failed: ${body.description ?? "provider error"}`);
}

export async function telegramRequest(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok?: boolean; result?: Record<string, unknown>; description?: string }> {
  const response = await fetch(`${config.TELEGRAM_BOT_API_BASE_URL}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json() as { ok?: boolean; result?: Record<string, unknown>; description?: string };
  if (!response.ok && response.status >= 500) throw new Error(`Telegram API unavailable (${response.status})`);
  return payload;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing from channel configuration`);
  return value;
}
