import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { pool, withTenantTransaction, withUserTransaction } from "./db";
import { AuthContext, AuthenticatedRequest, TenantRole } from "./types";

type TokenClaims = { sub: string; tid: string; mid: string; role: TenantRole };

export function signAccessToken(auth: AuthContext): string {
  return jwt.sign(
    { tid: auth.tenantId, mid: auth.membershipId, role: auth.role },
    config.JWT_SECRET,
    { subject: auth.userId, expiresIn: "8h", issuer: "novabooks", audience: "novabooks-web" }
  );
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const claims = jwt.verify(header.slice(7), config.JWT_SECRET, {
      issuer: "novabooks",
      audience: "novabooks-web"
    }) as jwt.JwtPayload & TokenClaims;
    if (!claims.sub || !claims.tid || !claims.mid || !["tenant_admin", "accountant", "staff"].includes(claims.role)) {
      res.status(401).json({ error: "Invalid access token claims" });
      return;
    }
    (req as AuthenticatedRequest).auth = {
      userId: claims.sub,
      tenantId: claims.tid,
      membershipId: claims.mid,
      role: claims.role
    };
    void withTenantTransaction(claims.tid, async (tx) => {
      const membership = await tx.query(
        `SELECT m.id, m.role, u.status AS user_status,
                t.subscription_status, t.trial_ends_at, t.expires_at
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.tenant_id = $1 AND m.id = $2 AND m.user_id = $3 AND m.status = 'active'`,
        [claims.tid, claims.mid, claims.sub]
      );
      const activeMembership = membership.rows[0];
      if (!activeMembership || activeMembership.user_status !== "active" || activeMembership.role !== claims.role) {
        throw new AuthenticationError("Tenant membership is no longer active");
      }
      if (
        !["active", "trial"].includes(activeMembership.subscription_status)
        || (activeMembership.trial_ends_at && new Date(activeMembership.trial_ends_at) <= new Date())
        || (activeMembership.expires_at && new Date(activeMembership.expires_at) <= new Date())
      ) {
        throw new TenantUnavailableError("Gói dịch vụ tenant hiện không hoạt động");
      }
    }, claims.sub).then(() => next()).catch((error: unknown) => {
      if (error instanceof AuthenticationError) {
        res.status(401).json({ error: error.message });
      } else if (error instanceof TenantUnavailableError) {
        res.status(403).json({ error: error.message });
      } else {
        next(error);
      }
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired access token" });
  }
}

export function requireRoles(...roles: TenantRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth || !roles.includes(auth.role)) {
      res.status(403).json({ error: "Insufficient permission" });
      return;
    }
    next();
  };
}

export async function registerTenant(input: {
  email: string;
  password: string;
  fullName: string;
  companyName: string;
  tenantSlug: string;
}): Promise<AuthContext> {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const passwordHash = await bcrypt.hash(input.password, 12);
  return withTenantTransaction(tenantId, async (tx) => {
    await tx.query(
      "INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)",
      [userId, input.email, passwordHash, input.fullName]
    );
    await tx.query(
      "INSERT INTO tenants (id, slug, name, trial_ends_at) VALUES ($1, $2, $3, now() + interval '14 days')",
      [tenantId, input.tenantSlug, input.companyName]
    );
    await tx.query(
      "INSERT INTO tenant_memberships (tenant_id, id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'tenant_admin', 'active', now())",
      [tenantId, randomUUID(), userId]
    );
    const membership = await tx.query<{ id: string }>(
      "SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId]
    );
    const membershipId = membership.rows[0]?.id;
    if (!membershipId) throw new Error("Tenant membership was not created");
    return {
      userId,
      tenantId,
      membershipId,
      role: "tenant_admin"
    };
  }, userId);
}

export async function loginUser(email: string, password: string, tenantId?: string): Promise<AuthContext> {
  const result = await withUserlessQuery(email);
  if (!result || !(await bcrypt.compare(password, result.password_hash))) {
    throw new AuthenticationError("Email hoặc mật khẩu không chính xác");
  }
  const memberships = await withUserTransaction(result.id, async (tx) => {
    const rows = await tx.query<{ tenant_id: string; id: string; role: TenantRole }>(
      "SELECT tenant_id, id, role FROM tenant_memberships WHERE user_id = $1 AND status = 'active' ORDER BY tenant_id",
      [result.id]
    );
    return rows.rows;
  });
  if (!memberships.length) throw new AuthenticationError("Tài khoản chưa thuộc doanh nghiệp đang hoạt động");
  const selected = tenantId
    ? memberships.find((membership) => membership.tenant_id === tenantId)
    : memberships.length === 1 ? memberships[0] : undefined;
  if (!selected) {
    if (tenantId) throw new AuthenticationError("Tài khoản không có quyền truy cập tenant đã chọn");
    throw new TenantSelectionRequired(memberships.map(({ tenant_id, role }) => ({ tenantId: tenant_id, role })));
  }
  return {
    userId: result.id,
    tenantId: selected.tenant_id,
    membershipId: selected.id,
    role: selected.role
  };
}

async function withUserlessQuery(email: string): Promise<{ id: string; password_hash: string } | null> {
  const result = await pool.query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM authenticate_user($1)",
    [email]
  );
  return result.rows[0] ?? null;
}

export class AuthenticationError extends Error {}

export class TenantUnavailableError extends Error {}

export class TenantSelectionRequired extends Error {
  constructor(public readonly memberships: Array<{ tenantId: string; role: TenantRole }>) {
    super("Chọn doanh nghiệp cần đăng nhập");
  }
}
