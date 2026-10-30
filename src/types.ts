import type { Request } from "express";

export type TenantRole = "tenant_admin" | "accountant" | "staff";

export type AuthContext = {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: TenantRole;
};

export type AuthenticatedRequest = Request & { auth: AuthContext };
