import { z } from "zod";
import { config } from "./config";

const invoiceAmountSchema = z.number().finite().max(9_999_999_999_999_999)
  .refine((value) => Number.isInteger(value * 10_000), "Số tiền tối đa 4 chữ số thập phân");

export const extractedInvoiceSchema = z.object({
  supplierName: z.string().nullable(),
  supplierTaxId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  subtotal: invoiceAmountSchema.nullable(),
  taxAmount: invoiceAmountSchema.nullable(),
  totalAmount: invoiceAmountSchema.nullable(),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    amount: z.number().nullable()
  })),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string())
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;

const responseSchema = {
  type: "OBJECT",
  properties: {
    supplierName: { type: "STRING", nullable: true },
    supplierTaxId: { type: "STRING", nullable: true },
    invoiceNumber: { type: "STRING", nullable: true },
    invoiceDate: { type: "STRING", nullable: true },
    currency: { type: "STRING", nullable: true },
    subtotal: { type: "NUMBER", nullable: true },
    taxAmount: { type: "NUMBER", nullable: true },
    totalAmount: { type: "NUMBER", nullable: true },
    lineItems: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          quantity: { type: "NUMBER", nullable: true },
          unitPrice: { type: "NUMBER", nullable: true },
          amount: { type: "NUMBER", nullable: true }
        },
        required: ["description", "quantity", "unitPrice", "amount"]
      }
    },
    confidence: { type: "NUMBER" },
    warnings: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: [
    "supplierName", "supplierTaxId", "invoiceNumber", "invoiceDate", "currency",
    "subtotal", "taxAmount", "totalAmount", "lineItems", "confidence", "warnings"
  ]
};

export async function extractInvoice(file: Buffer, mimeType: string): Promise<ExtractedInvoice> {
  if (!config.GEMINI_API_KEY) throw new Error("Gemini is not configured: set GEMINI_API_KEY");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: "Đọc chứng từ/hóa đơn trong ảnh. Chỉ trích xuất thông tin nhìn thấy, không suy đoán. Trả null cho trường không đọc được. Tiền là số thập phân, ngày theo YYYY-MM-DD. Ghi cảnh báo nếu ảnh mờ hoặc phép tính không khớp." },
          { inline_data: { mime_type: mimeType, data: file.toString("base64") } }
        ]
      }],
      generationConfig: {
        response_mime_type: "application/json",
        response_schema: responseSchema,
        temperature: 0
      }
    }),
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${details.slice(0, 500)}`);
  }
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Gemini returned no structured invoice content");
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`Gemini returned invalid JSON: ${error instanceof Error ? error.message : "parse failure"}`);
  }
  return extractedInvoiceSchema.parse(decoded);
}
