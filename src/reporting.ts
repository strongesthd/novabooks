import { config } from "./config";
import { decryptJson } from "./crypto";
import { listReportTenants, withWebhookTransaction } from "./db";
import { activeChannels, sendTelegramVoice, sendText } from "./channels";

let reportRunning = false;
const completedTenantDates = new Map<string, string>();

export function startDailyReporter(): void {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(config.DAILY_REPORT_CRON);
  if (!match) throw new Error("DAILY_REPORT_CRON must use the daily format: '<minute> <hour> * * *'");
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error("DAILY_REPORT_CRON has an invalid hour or minute");

  setInterval(() => {
    const now = new Date();
    void runScheduledReports(now, hour, minute).catch((error: unknown) => {
      console.error("daily report scheduler failed", {
        error: error instanceof Error ? error.message : "unknown error"
      });
    });
  }, 15_000).unref();
}

async function runScheduledReports(now: Date, scheduledHour: number, scheduledMinute: number): Promise<void> {
  const tenants = await listReportTenants();
  for (const tenant of tenants) {
    let localDate: string | undefined;
    try {
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: tenant.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(now);
      const parts = Object.fromEntries(local.map(({ type, value }) => [type, value]));
      if (Number(parts.hour) !== scheduledHour || Number(parts.minute) !== scheduledMinute) continue;
      localDate = `${parts.year}-${parts.month}-${parts.day}`;
      if (completedTenantDates.get(tenant.tenant_id) === localDate) continue;
      completedTenantDates.set(tenant.tenant_id, localDate);
      await reportTenant(tenant.tenant_id, tenant.timezone);
    } catch (error) {
      if (completedTenantDates.get(tenant.tenant_id) === localDate) completedTenantDates.delete(tenant.tenant_id);
      console.error("tenant daily report failed", {
        tenantId: tenant.tenant_id,
        error: error instanceof Error ? error.message : "unknown error"
      });
    }
  }
}

export async function runDailyReports(): Promise<void> {
  if (reportRunning) return;
  reportRunning = true;
  try {
    const tenants = await listReportTenants();
    for (const tenant of tenants) {
      try {
        await reportTenant(tenant.tenant_id, tenant.timezone);
      } catch (error) {
        console.error("tenant daily report failed", {
          tenantId: tenant.tenant_id,
          error: error instanceof Error ? error.message : "unknown error"
        });
      }
    }
  } finally {
    reportRunning = false;
  }
}

async function reportTenant(tenantId: string, timezone: string): Promise<void> {
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const reportDateParts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  const reportDate = `${reportDateParts.year}-${reportDateParts.month}-${reportDateParts.day}`;
  const report = await withWebhookTransaction(tenantId, async (tx) => {
    const channels = await activeChannels(tx);
    const totals = await tx.query<{
      currency: string;
      entry_count: string;
      debit_total: string;
    }>(
      `SELECT e.currency, count(DISTINCT e.id)::text AS entry_count,
              COALESCE(sum(l.debit), 0)::text AS debit_total
       FROM accounting_entries AS e
       JOIN accounting_entry_lines AS l
         ON l.tenant_id = e.tenant_id AND l.accounting_entry_id = e.id
       WHERE e.tenant_id = $1 AND e.entry_date = $2::date AND e.status = 'posted'
       GROUP BY e.currency ORDER BY e.currency`,
      [tenantId, reportDate]
    );
    return { channels, totals: totals.rows };
  });
  if (!report.channels.length) return;
  const totalsText = report.totals.length
    ? report.totals.map((row) =>
        `${row.currency}: ${Number(row.debit_total).toLocaleString("vi-VN")} (tổng phát sinh Nợ, ${row.entry_count} bút toán)`
      ).join("\n")
    : "Hôm nay chưa có bút toán được ghi sổ.";
  const summary = `NovaBooks — Báo cáo ngày ${reportDate}\n${totalsText}`;

  for (const channel of report.channels) {
    try {
      const alreadySent = await withWebhookTransaction(tenantId, async (tx) => {
        const result = await tx.query(
          "SELECT 1 FROM report_runs WHERE tenant_id = $1 AND report_date = $2 AND channel_id = $3 AND status = 'sent' LIMIT 1",
          [tenantId, reportDate, channel.id]
        );
        return result.rowCount !== 0;
      });
      if (alreadySent) continue;

      const secrets = decryptJson(channel.credentials_ciphertext);
      let voice: Buffer | null = null;
      if (channel.provider === "telegram" && config.TTS_API_KEY && config.TTS_VOICE_ID) {
        voice = await synthesizeSpeech(summary);
      }
      await sendText(channel, secrets, summary);
      if (voice) await sendTelegramVoice(channel, secrets, voice);
      await withWebhookTransaction(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO report_runs (tenant_id, report_date, channel_id, status, summary)
           VALUES ($1, $2, $3, 'sent', $4)
           ON CONFLICT (tenant_id, report_date, channel_id) WHERE status = 'sent' DO NOTHING`,
          [tenantId, reportDate, channel.id, summary]
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delivery failure";
      await withWebhookTransaction(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO report_runs (tenant_id, report_date, channel_id, status, summary, error_code)
           VALUES ($1, $2, $3, 'failed', $4, $5)`,
          [tenantId, reportDate, channel.id, summary, message.slice(0, 300)]
        );
      });
      console.error("report delivery failed", { tenantId, channelId: channel.id, error: message });
    }
  }
}

async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.TTS_VOICE_ID)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": config.TTS_API_KEY
      },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(45_000)
    }
  );
  if (!response.ok) throw new Error(`TTS provider failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
