-- Least-data lookup functions used by anonymous webhooks and scheduled workers.
BEGIN;

CREATE OR REPLACE FUNCTION resolve_channel_by_webhook_key(p_key_hash bytea)
RETURNS TABLE (tenant_id uuid, channel_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT c.tenant_id, c.id
    FROM tenant_channels AS c
    JOIN tenants AS t ON t.id = c.tenant_id
    WHERE c.webhook_key_hash = p_key_hash
      AND c.status = 'active'
      AND t.subscription_status IN ('trial', 'active')
      AND (t.trial_ends_at IS NULL OR t.trial_ends_at > now())
      AND (t.expires_at IS NULL OR t.expires_at > now())
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION list_report_tenants()
RETURNS TABLE (tenant_id uuid, timezone text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT id, tenants.timezone
    FROM tenants
    WHERE subscription_status IN ('trial', 'active')
      AND (trial_ends_at IS NULL OR trial_ends_at > now())
      AND (expires_at IS NULL OR expires_at > now())
$$;

REVOKE ALL ON FUNCTION resolve_channel_by_webhook_key(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_report_tenants() FROM PUBLIC;

CREATE TABLE report_runs (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    report_date date NOT NULL,
    channel_id uuid,
    status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
    summary text NOT NULL,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, channel_id)
        REFERENCES tenant_channels (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX report_runs_tenant_date_channel_uq
    ON report_runs (tenant_id, report_date, channel_id)
    WHERE status = 'sent';
CREATE INDEX report_runs_tenant_created_idx
    ON report_runs (tenant_id, created_at DESC);

CREATE UNIQUE INDEX temp_vouchers_tenant_source_event_uq
    ON temp_vouchers (tenant_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_runs
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
