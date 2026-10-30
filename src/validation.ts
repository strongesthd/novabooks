import { z } from "zod";

export const registerSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  fullName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(180),
  tenantSlug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,48}$/)
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  tenantId: z.uuid().optional()
});

export const channelSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("telegram"),
    botToken: z.string().min(20).max(300),
    chatId: z.string().min(1).max(128)
  }),
  z.object({
    provider: z.literal("zalo_oa"),
    oaId: z.string().min(1).max(128),
    accessToken: z.string().min(20).max(400),
    appSecret: z.string().min(16).max(300),
    recipientId: z.string().min(1).max(128)
  })
]);

export const reviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional()
});

export const voucherEditSchema = z.object({
  supplierName: z.string().trim().max(200).nullable().optional(),
  invoiceNumber: z.string().trim().max(100).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  subtotal: z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional(),
  taxAmount: z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional(),
  totalAmount: z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional()
});

export const inviteSchema = z.object({
  email: z.email().max(254),
  role: z.enum(["accountant", "staff"])
});

export const productSchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2).max(200),
  unit: z.string().trim().max(40).optional(),
  defaultUnitPrice: z.string().regex(/^\d+(?:\.\d{1,4})?$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("VND"),
  taxRate: z.number().min(0).max(100).optional()
});
