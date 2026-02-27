-- Estimates table
CREATE TABLE estimates (
    id                  SERIAL PRIMARY KEY,
    number              TEXT UNIQUE NOT NULL,

    client_id           INTEGER NOT NULL REFERENCES clients(id),
    client_snapshot     JSONB NOT NULL,

    issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until         DATE,

    currency            CHAR(3) NOT NULL DEFAULT 'EUR',
    vat_rate            NUMERIC(5,2) NOT NULL DEFAULT 19.00,
    vat_label           TEXT DEFAULT 'VAT',
    vat_note            TEXT,
    reverse_charge      BOOLEAN DEFAULT FALSE,

    subtotal            NUMERIC(12,2) DEFAULT 0,
    vat_amount          NUMERIC(12,2) DEFAULT 0,
    total               NUMERIC(12,2) DEFAULT 0,

    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                            'draft', 'sent', 'viewed',
                            'accepted', 'rejected', 'expired', 'converted'
                        )),

    view_token          TEXT UNIQUE NOT NULL,

    first_viewed_at     TIMESTAMPTZ,
    last_viewed_at      TIMESTAMPTZ,
    view_count          INTEGER DEFAULT 0,

    pdf_filename        TEXT,

    terms_text          TEXT,
    accepted_at         TIMESTAMPTZ,
    accepted_ip         INET,
    accepted_user_agent TEXT,

    notes               TEXT,
    internal_notes      TEXT,
    footer_text         TEXT,

    converted_invoice_id INTEGER REFERENCES invoices(id),

    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_estimates_status ON estimates(status);
CREATE INDEX idx_estimates_client ON estimates(client_id);
CREATE INDEX idx_estimates_valid_until ON estimates(valid_until);
CREATE INDEX idx_estimates_view_token ON estimates(view_token);

-- Estimate line items
CREATE TABLE estimate_lines (
    id              SERIAL PRIMARY KEY,
    estimate_id     INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    description     TEXT NOT NULL,
    detail          TEXT,
    quantity        NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit_code       TEXT DEFAULT 'HUR'
                    CHECK (unit_code IN ('HUR', 'DAY', 'EA', 'MON', 'C62')),
    unit_price      NUMERIC(12,2) NOT NULL,
    line_total      NUMERIC(12,2) NOT NULL,
    sort_order      INTEGER DEFAULT 0
);

CREATE INDEX idx_estimate_lines_estimate ON estimate_lines(estimate_id);

-- Estimate view tracking
CREATE TABLE estimate_views (
    id              SERIAL PRIMARY KEY,
    estimate_id     INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
    viewed_at       TIMESTAMPTZ DEFAULT NOW(),
    ip_address      INET,
    user_agent      TEXT,
    referrer        TEXT
);

-- Back-reference from invoices to the estimate they were created from
ALTER TABLE invoices ADD COLUMN estimate_id INTEGER REFERENCES estimates(id);

-- Allow email_log to reference estimates
ALTER TABLE email_log ADD COLUMN estimate_id INTEGER REFERENCES estimates(id);
