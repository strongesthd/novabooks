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

const inventoryDecimal = z.string().regex(/^\d{1,16}(?:\.\d{1,4})?$/);

export const reviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
  accountMappings: z.object({
    expenseAccountCode: z.string().trim().min(1).max(64),
    inputTaxAccountCode: z.string().trim().min(1).max(64),
    payableAccountCode: z.string().trim().min(1).max(64),
    inventoryAccountCode: z.string().trim().min(1).max(64).nullable().optional()
  }).optional(),
  inventoryLines: z.array(z.object({
    lineIndex: z.number().int().min(0).max(99),
    itemId: z.uuid(),
    quantity: inventoryDecimal,
    amount: inventoryDecimal
  })).max(100).optional()
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
  unit: z.string().trim().max(40).nullable().optional(),
  defaultUnitPrice: z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).default("VND"),
  taxRate: z.number().min(0).max(100).nullable().optional()
});

export const supplierSchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2).max(200),
  taxId: z.string().trim().max(32).nullable().optional(),
  email: z.union([z.email().max(254), z.literal("")]).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional()
});

export const ledgerMappingSchema = z.object({
  expenseAccountCode: z.string().trim().min(1).max(64),
  inputTaxAccountCode: z.string().trim().min(1).max(64),
  payableAccountCode: z.string().trim().min(1).max(64),
  inventoryAccountCode: z.string().trim().min(1).max(64).nullable().optional()
});

export const inventoryItemSchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(2).max(200),
  category: z.string().trim().max(120).nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  minimumQuantity: inventoryDecimal.default("0"),
  location: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});

export const inventoryItemStatusSchema = z.object({
  status: z.enum(["active", "archived"])
});

export const inventoryMovementSchema = z.object({
  itemId: z.uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  documentNumber: z.string().trim().min(1).max(100),
  type: z.enum(["purchase_in", "production_out", "return_in", "adjustment_in", "adjustment_out"]),
  quantity: inventoryDecimal.refine((value) => Number(value) > 0),
  recipient: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
});

export const inventoryAssignmentSchema = z.object({
  itemId: z.uuid(),
  documentNumber: z.string().trim().min(1).max(100),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recipient: z.string().trim().min(1).max(200),
  team: z.string().trim().max(120).nullable().optional(),
  quantity: inventoryDecimal.refine((value) => Number(value) > 0),
  condition: z.string().trim().max(120).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional()
}).refine((value) => !value.dueDate || value.dueDate >= value.issuedAt, {
  path: ["dueDate"],
  message: "Hạn thu hồi không được trước ngày cấp"
});

export const inventoryImportSchema = z.object({
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
