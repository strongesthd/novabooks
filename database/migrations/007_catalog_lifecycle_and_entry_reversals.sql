BEGIN;

ALTER TABLE suppliers
    ADD COLUMN status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived'));

CREATE UNIQUE INDEX accounting_entries_tenant_reversal_uq
    ON accounting_entries (tenant_id, reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

COMMIT;
