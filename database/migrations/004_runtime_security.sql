BEGIN;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self_access ON users
    FOR ALL
    USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY users_tenant_members_visible ON users
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM tenant_memberships AS m
            WHERE m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND m.user_id = users.id
        )
    );

CREATE OR REPLACE FUNCTION authenticate_user(p_email citext)
RETURNS TABLE (id uuid, password_hash text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT u.id, u.password_hash
    FROM users AS u
    WHERE u.email = p_email AND u.status = 'active'
    LIMIT 1
$$;
REVOKE ALL ON FUNCTION authenticate_user(citext) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON tenants, users, tenant_memberships,
    tenant_channels, suppliers, products, ingestion_events, temp_vouchers,
    accounting_entries, accounting_entry_lines, audit_logs, report_runs
    TO novabooks;
GRANT EXECUTE ON FUNCTION authenticate_user(citext) TO novabooks;
GRANT EXECUTE ON FUNCTION resolve_channel_by_webhook_key(bytea) TO novabooks;
GRANT EXECUTE ON FUNCTION list_report_tenants() TO novabooks;

COMMIT;
