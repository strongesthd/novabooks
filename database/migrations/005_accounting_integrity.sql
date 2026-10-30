BEGIN;

REVOKE UPDATE ON audit_logs FROM novabooks;

CREATE OR REPLACE FUNCTION prevent_posted_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('posted', 'reversed') THEN
        RAISE EXCEPTION 'Posted accounting entries are immutable; create a correcting entry'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER accounting_entries_immutable_after_posting
BEFORE UPDATE OR DELETE ON accounting_entries
FOR EACH ROW EXECUTE FUNCTION prevent_posted_entry_mutation();

CREATE OR REPLACE FUNCTION prevent_posted_entry_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status text;
    affected_tenant uuid;
    affected_entry uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        affected_tenant := NEW.tenant_id;
        affected_entry := NEW.accounting_entry_id;
    ELSE
        affected_tenant := OLD.tenant_id;
        affected_entry := OLD.accounting_entry_id;
    END IF;
    SELECT status INTO parent_status
    FROM accounting_entries
    WHERE tenant_id = affected_tenant AND id = affected_entry;
    IF parent_status IN ('posted', 'reversed') THEN
        RAISE EXCEPTION 'Lines of posted accounting entries are immutable'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER accounting_entry_lines_immutable_after_posting
BEFORE INSERT OR UPDATE OR DELETE ON accounting_entry_lines
FOR EACH ROW EXECUTE FUNCTION prevent_posted_entry_line_mutation();

CREATE OR REPLACE FUNCTION assert_posted_entry_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    debit_total numeric;
    credit_total numeric;
    line_count bigint;
BEGIN
    IF NEW.status <> 'posted' THEN
        RETURN NEW;
    END IF;
    SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO line_count, debit_total, credit_total
    FROM accounting_entry_lines
    WHERE tenant_id = NEW.tenant_id AND accounting_entry_id = NEW.id;
    IF line_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'Posted accounting entry must have at least two lines and balanced debit/credit'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER accounting_entries_must_balance
AFTER INSERT OR UPDATE ON accounting_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_posted_entry_balanced();

COMMIT;
