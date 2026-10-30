-- NovaBooks initial shared-schema / shared-database multi-tenant schema.
-- Target: PostgreSQL 15+. Apply with a dedicated migration role.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    plan_code text NOT NULL DEFAULT 'trial',
    subscription_status text NOT NULL DEFAULT 'trial'
        CHECK (subscription_status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled', 'expired')),
    trial_ends_at timestamptz,
    expires_at timestamptz,
    timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    default_currency char(3) NOT NULL DEFAULT 'VND',
    settings jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(settings) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'locked', 'pending_verification', 'deleted')),
    email_verified_at timestamptz,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('tenant_admin', 'accountant', 'staff')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
    invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    invited_at timestamptz,
    joined_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_status_idx
    ON tenant_memberships (user_id, status);
CREATE INDEX tenant_memberships_tenant_role_idx
    ON tenant_memberships (tenant_id, role, status);

CREATE TABLE tenant_channels (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('telegram', 'zalo_oa')),
    external_account_id text,
    display_name text,
    credentials_ciphertext bytea NOT NULL,
    encryption_key_version text NOT NULL,
    webhook_key_hash bytea NOT NULL UNIQUE,
    config jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(config) = 'object'),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'disabled', 'error')),
    last_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK (external_account_id IS NULL OR length(external_account_id) > 0)
);
CREATE UNIQUE INDEX tenant_channels_provider_account_uq
    ON tenant_channels (provider, external_account_id)
    WHERE external_account_id IS NOT NULL;
CREATE INDEX tenant_channels_tenant_status_idx
    ON tenant_channels (tenant_id, status, provider);

CREATE TABLE suppliers (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    code text NOT NULL,
    name text NOT NULL,
    tax_id text,
    email citext,
    phone text,
    address text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX suppliers_tenant_code_uq
    ON suppliers (tenant_id, lower(code));
CREATE INDEX suppliers_tenant_name_idx
    ON suppliers (tenant_id, lower(name));
CREATE UNIQUE INDEX suppliers_tenant_tax_id_uq
    ON suppliers (tenant_id, tax_id)
    WHERE tax_id IS NOT NULL;

CREATE TABLE products (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    code text NOT NULL,
    name text NOT NULL,
    unit text,
    default_unit_price numeric(20, 4),
    currency char(3) NOT NULL DEFAULT 'VND',
    tax_rate numeric(7, 4),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK (default_unit_price IS NULL OR default_unit_price >= 0),
    CHECK (tax_rate IS NULL OR tax_rate BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX products_tenant_code_uq
    ON products (tenant_id, lower(code));
CREATE INDEX products_tenant_name_idx
    ON products (tenant_id, lower(name));

CREATE TABLE ingestion_events (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    provider_event_id text NOT NULL,
    payload_hash bytea NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processing_status text NOT NULL DEFAULT 'received'
        CHECK (processing_status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
    last_error_code text,
    processed_at timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, channel_id, provider_event_id),
    FOREIGN KEY (tenant_id, channel_id)
        REFERENCES tenant_channels (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX ingestion_events_tenant_status_time_idx
    ON ingestion_events (tenant_id, processing_status, received_at DESC);

CREATE TABLE temp_vouchers (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_channel_id uuid,
    source_event_id uuid,
    submitted_by_membership_id uuid,
    supplier_id uuid,
    document_type text NOT NULL DEFAULT 'purchase_invoice',
    status text NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'extracting', 'needs_review', 'approved', 'rejected', 'posted', 'failed')),
    storage_key text NOT NULL,
    file_sha256 bytea NOT NULL,
    mime_type text NOT NULL,
    file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0),
    invoice_number text,
    invoice_date date,
    currency char(3),
    subtotal numeric(20, 4),
    tax_amount numeric(20, 4),
    total_amount numeric(20, 4),
    extracted_data jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(extracted_data) = 'object'),
    extraction_schema_version text,
    ai_provider text,
    ai_model text,
    ai_confidence numeric(5, 4) CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
    review_note text,
    approved_by_membership_id uuid,
    approved_at timestamptz,
    rejected_by_membership_id uuid,
    rejected_at timestamptz,
    posted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, source_channel_id)
        REFERENCES tenant_channels (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_event_id)
        REFERENCES ingestion_events (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, submitted_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES suppliers (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, approved_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, rejected_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    CHECK (subtotal IS NULL OR subtotal >= 0),
    CHECK (tax_amount IS NULL OR tax_amount >= 0),
    CHECK (total_amount IS NULL OR total_amount >= 0),
    CHECK (status <> 'approved' OR (approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL)),
    CHECK (status <> 'rejected' OR (rejected_by_membership_id IS NOT NULL AND rejected_at IS NOT NULL))
);
CREATE INDEX temp_vouchers_tenant_status_time_idx
    ON temp_vouchers (tenant_id, status, created_at DESC);
CREATE INDEX temp_vouchers_tenant_supplier_date_idx
    ON temp_vouchers (tenant_id, supplier_id, invoice_date DESC);
CREATE INDEX temp_vouchers_extracted_data_gin_idx
    ON temp_vouchers USING gin (extracted_data);

CREATE TABLE accounting_entries (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    voucher_id uuid,
    entry_number text NOT NULL,
    entry_date date NOT NULL,
    description text NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'posted', 'reversed')),
    created_by_membership_id uuid,
    posted_by_membership_id uuid,
    posted_at timestamptz,
    reverses_entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, entry_number),
    FOREIGN KEY (tenant_id, voucher_id)
        REFERENCES temp_vouchers (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, created_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, posted_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, reverses_entry_id)
        REFERENCES accounting_entries (tenant_id, id) ON DELETE RESTRICT,
    CHECK (status <> 'posted' OR (posted_by_membership_id IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX accounting_entries_tenant_voucher_uq
    ON accounting_entries (tenant_id, voucher_id)
    WHERE voucher_id IS NOT NULL;
CREATE INDEX accounting_entries_tenant_date_status_idx
    ON accounting_entries (tenant_id, entry_date, status);

CREATE TABLE accounting_entry_lines (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    accounting_entry_id uuid NOT NULL,
    line_number integer NOT NULL CHECK (line_number > 0),
    account_code text NOT NULL,
    account_name text NOT NULL,
    description text,
    supplier_id uuid,
    product_id uuid,
    debit numeric(20, 4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit numeric(20, 4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, accounting_entry_id, line_number),
    FOREIGN KEY (tenant_id, accounting_entry_id)
        REFERENCES accounting_entries (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, supplier_id)
        REFERENCES suppliers (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, product_id)
        REFERENCES products (tenant_id, id) ON DELETE RESTRICT,
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX accounting_entry_lines_tenant_account_idx
    ON accounting_entry_lines (tenant_id, account_code);

CREATE TABLE audit_logs (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    request_id text,
    ip_address inet,
    user_agent text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_logs_tenant_time_idx
    ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_tenant_resource_idx
    ON audit_logs (tenant_id, resource_type, resource_id, created_at DESC);

-- Tenant directory row can only be read/written in its own tenant context.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
    USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Apply the same tenant boundary to every tenant-owned table.
DO $$
DECLARE
    table_name text;
    tenant_tables text[] := ARRAY[
        'tenant_memberships',
        'tenant_channels',
        'suppliers',
        'products',
        'ingestion_events',
        'temp_vouchers',
        'accounting_entries',
        'accounting_entry_lines',
        'audit_logs'
    ];
BEGIN
    FOREACH table_name IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
             WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END
$$;

-- Restrict runtime DB grants separately. Do not grant the application role
-- ownership, superuser, BYPASSRLS, or unrestricted access to the users table.
COMMIT;
