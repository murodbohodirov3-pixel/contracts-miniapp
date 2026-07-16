CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  contractor text NOT NULL CHECK (length(trim(contractor)) > 0),
  contractor_inn text,
  contract_number text,
  contract_date date NOT NULL,
  contract_status text NOT NULL DEFAULT 'active' CHECK (contract_status IN ('active', 'closed', 'paused', 'problem')),
  amount_uzs numeric(18,2) NOT NULL CHECK (amount_uzs > 0),
  exchange_rate numeric(18,6) NOT NULL CHECK (exchange_rate > 0),
  note text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
