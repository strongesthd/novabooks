BEGIN;

ALTER TABLE tenant_account_mappings
    DROP CONSTRAINT tenant_account_mappings_mapping_key_check;
ALTER TABLE tenant_account_mappings
    ADD CONSTRAINT tenant_account_mappings_mapping_key_check
    CHECK (mapping_key IN ('expense', 'input_tax', 'accounts_payable', 'inventory_asset'));

CREATE TABLE inventory_items (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    code text NOT NULL,
    name text NOT NULL,
    category text,
    unit text,
    minimum_quantity numeric(20, 4) NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0),
    location text,
    notes text,
    opening_quantity numeric(20, 4) NOT NULL DEFAULT 0 CHECK (opening_quantity >= 0),
    opening_date date NOT NULL DEFAULT CURRENT_DATE,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK (length(trim(code)) BETWEEN 1 AND 64),
    CHECK (length(trim(name)) BETWEEN 2 AND 200),
    CHECK (category IS NULL OR length(category) <= 120),
    CHECK (unit IS NULL OR length(unit) <= 40),
    CHECK (location IS NULL OR length(location) <= 200),
    CHECK (notes IS NULL OR length(notes) <= 2000)
);
CREATE UNIQUE INDEX inventory_items_tenant_code_uq ON inventory_items (tenant_id, lower(code));
CREATE INDEX inventory_items_tenant_name_idx ON inventory_items (tenant_id, lower(name));
CREATE INDEX inventory_items_tenant_status_idx ON inventory_items (tenant_id, status, code);

CREATE FUNCTION prevent_inventory_opening_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.opening_quantity IS DISTINCT FROM OLD.opening_quantity
       OR NEW.opening_date IS DISTINCT FROM OLD.opening_date THEN
        RAISE EXCEPTION 'Inventory opening balance is immutable; record an adjustment movement instead'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_items_opening_balance_immutable
    BEFORE UPDATE ON inventory_items
    FOR EACH ROW EXECUTE FUNCTION prevent_inventory_opening_balance_update();

CREATE TABLE inventory_import_batches (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    file_sha256 bytea NOT NULL,
    file_name text NOT NULL,
    opening_date date NOT NULL,
    item_count integer NOT NULL CHECK (item_count >= 0),
    movement_count integer NOT NULL CHECK (movement_count >= 0),
    assignment_count integer NOT NULL CHECK (assignment_count >= 0),
    imported_by_membership_id uuid NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, file_sha256),
    FOREIGN KEY (tenant_id, imported_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    CHECK (length(file_name) BETWEEN 1 AND 255)
);

CREATE TABLE inventory_assignments (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL,
    document_number text NOT NULL,
    issued_at date NOT NULL,
    recipient text NOT NULL,
    team text,
    quantity numeric(20, 4) NOT NULL CHECK (quantity > 0),
    condition text,
    due_date date,
    notes text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned')),
    returned_at timestamptz,
    source_kind text NOT NULL CHECK (source_kind IN ('manual', 'workbook')),
    source_key text,
    source_batch_id uuid,
    created_by_membership_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)
        REFERENCES inventory_items (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_batch_id)
        REFERENCES inventory_import_batches (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, created_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    CHECK (length(trim(document_number)) BETWEEN 1 AND 100),
    CHECK (length(trim(recipient)) BETWEEN 1 AND 200),
    CHECK (team IS NULL OR length(team) <= 120),
    CHECK (condition IS NULL OR length(condition) <= 120),
    CHECK (notes IS NULL OR length(notes) <= 2000),
    CHECK ((status = 'active' AND returned_at IS NULL) OR status = 'returned')
);
CREATE UNIQUE INDEX inventory_assignments_tenant_source_uq
    ON inventory_assignments (tenant_id, source_key)
    WHERE source_key IS NOT NULL;
CREATE INDEX inventory_assignments_tenant_status_idx
    ON inventory_assignments (tenant_id, status, issued_at DESC);
CREATE INDEX inventory_assignments_tenant_item_idx
    ON inventory_assignments (tenant_id, item_id, issued_at DESC);

CREATE TABLE inventory_movements (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL,
    movement_date date NOT NULL,
    document_number text NOT NULL,
    movement_type text NOT NULL CHECK (
        movement_type IN ('purchase_in', 'production_out', 'issue_out', 'return_in', 'adjustment_in', 'adjustment_out')
    ),
    quantity numeric(20, 4) NOT NULL CHECK (quantity > 0),
    recipient text,
    notes text,
    source_kind text NOT NULL CHECK (source_kind IN ('manual', 'workbook', 'voucher', 'assignment')),
    source_key text,
    source_batch_id uuid,
    source_voucher_id uuid,
    source_line_index integer,
    source_assignment_id uuid,
    created_by_membership_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)
        REFERENCES inventory_items (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_batch_id)
        REFERENCES inventory_import_batches (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_voucher_id)
        REFERENCES temp_vouchers (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_assignment_id)
        REFERENCES inventory_assignments (tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, created_by_membership_id)
        REFERENCES tenant_memberships (tenant_id, id) ON DELETE RESTRICT,
    CHECK (length(trim(document_number)) BETWEEN 1 AND 100),
    CHECK (recipient IS NULL OR length(recipient) <= 200),
    CHECK (notes IS NULL OR length(notes) <= 2000),
    CHECK ((source_voucher_id IS NULL) = (source_line_index IS NULL)),
    CHECK (source_line_index IS NULL OR source_line_index >= 0)
);
CREATE UNIQUE INDEX inventory_movements_tenant_source_uq
    ON inventory_movements (tenant_id, source_key)
    WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX inventory_movements_tenant_voucher_line_uq
    ON inventory_movements (tenant_id, source_voucher_id, source_line_index)
    WHERE source_voucher_id IS NOT NULL;
CREATE INDEX inventory_movements_tenant_item_date_idx
    ON inventory_movements (tenant_id, item_id, movement_date DESC, created_at DESC);
CREATE INDEX inventory_movements_tenant_date_idx
    ON inventory_movements (tenant_id, movement_date DESC, created_at DESC);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'inventory_items', 'inventory_import_batches', 'inventory_assignments', 'inventory_movements'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON inventory_items TO novabooks;
GRANT SELECT, INSERT ON inventory_import_batches, inventory_movements TO novabooks;
GRANT SELECT, INSERT ON inventory_assignments TO novabooks;
GRANT UPDATE (status, returned_at) ON inventory_assignments TO novabooks;

COMMIT;
