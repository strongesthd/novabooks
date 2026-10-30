-- Authenticated users may enumerate their own memberships to select a tenant.
-- Writes remain restricted to the currently selected tenant by RLS.
BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON tenant_memberships;

CREATE POLICY tenant_memberships_read ON tenant_memberships
    FOR SELECT
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY tenant_memberships_write ON tenant_memberships
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
