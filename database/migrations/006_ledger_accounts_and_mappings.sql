BEGIN;

CREATE TABLE ledger_accounts (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    account_code text NOT NULL,
    account_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, account_code),
    CHECK (length(trim(account_code)) BETWEEN 1 AND 64),
    CHECK (length(trim(account_name)) BETWEEN 1 AND 200)
);

CREATE TABLE tenant_account_mappings (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    mapping_key text NOT NULL
        CHECK (mapping_key IN ('expense', 'input_tax', 'accounts_payable')),
    account_code text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, mapping_key),
    FOREIGN KEY (tenant_id, account_code)
        REFERENCES ledger_accounts (tenant_id, account_code) ON DELETE RESTRICT
);

ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_accounts
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_account_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_account_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_account_mappings
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON ledger_accounts, tenant_account_mappings TO novabooks;

COMMIT;
