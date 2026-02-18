-- Schema is created by the app before migrations run.
-- search_path is set to konto,public on every connection.

-- ============================================================
-- Business profile (single row — your company details)
-- ============================================================
CREATE TABLE business_profile (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    name            TEXT NOT NULL,
    address_line1   TEXT,
    address_line2   TEXT,
    city            TEXT,
    postal_code     TEXT,
    country_code    CHAR(2) DEFAULT 'DE',
    vat_number      TEXT,
    tax_number      TEXT,
    email           TEXT,
    phone           TEXT,
    website         TEXT,
    bank_name       TEXT,
    iban            TEXT,
    bic             TEXT,
    CONSTRAINT single_row CHECK (id = 1)
);

-- ============================================================
-- Clients
-- ============================================================
CREATE TABLE clients (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    contact_person  TEXT,
    email           TEXT,
    address_line1   TEXT,
    address_line2   TEXT,
    city            TEXT,
    postal_code     TEXT,
    country_code    CHAR(2) DEFAULT 'DE',
    vat_number      TEXT,
    currency        CHAR(3) DEFAULT 'EUR',
    default_vat_rate NUMERIC(5,2) DEFAULT 19.00,
    payment_terms_days INTEGER DEFAULT 30,
    notes           TEXT,
    archived        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Invoice numbering sequences
-- ============================================================
CREATE TABLE invoice_sequences (
    id              SERIAL PRIMARY KEY,
    prefix          TEXT NOT NULL,
    year            INTEGER NOT NULL,
    next_number     INTEGER DEFAULT 1,
    UNIQUE(prefix, year)
);

-- ============================================================
-- Invoices
-- ============================================================
CREATE TABLE invoices (
    id              SERIAL PRIMARY KEY,
    number          TEXT UNIQUE NOT NULL,

    client_id       INTEGER NOT NULL REFERENCES clients(id),
    client_snapshot JSONB NOT NULL,

    issue_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date        DATE,

    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    vat_rate        NUMERIC(5,2) NOT NULL DEFAULT 19.00,
    vat_label       TEXT DEFAULT 'VAT',
    vat_note        TEXT,
    reverse_charge  BOOLEAN DEFAULT FALSE,

    subtotal        NUMERIC(12,2) DEFAULT 0,
    vat_amount      NUMERIC(12,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    amount_paid     NUMERIC(12,2) DEFAULT 0,

    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN (
                        'draft',
                        'sent',
                        'viewed',
                        'paid',
                        'partially_paid',
                        'overdue',
                        'cancelled'
                    )),

    view_token      TEXT UNIQUE NOT NULL,
    view_password   TEXT,
    first_viewed_at TIMESTAMPTZ,
    last_viewed_at  TIMESTAMPTZ,
    view_count      INTEGER DEFAULT 0,

    einvoice_format TEXT DEFAULT 'ZUGFeRD',
    pdf_filename    TEXT,

    last_reminder_at TIMESTAMPTZ,
    reminder_count  INTEGER DEFAULT 0,

    payment_details TEXT,
    notes           TEXT,
    internal_notes  TEXT,
    footer_text     TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_due_date ON invoices(due_date);
CREATE INDEX idx_invoices_view_token ON invoices(view_token);

-- ============================================================
-- Invoice line items
-- ============================================================
CREATE TABLE invoice_lines (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description     TEXT NOT NULL,
    detail          TEXT,
    quantity        NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit_code       TEXT DEFAULT 'HUR',
    unit_price      NUMERIC(12,2) NOT NULL,
    line_total      NUMERIC(12,2) NOT NULL,
    sort_order      INTEGER DEFAULT 0
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- ============================================================
-- Payments (supports partial payments)
-- ============================================================
CREATE TABLE payments (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount          NUMERIC(12,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    paid_at         DATE NOT NULL DEFAULT CURRENT_DATE,
    method          TEXT,
    reference       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Invoice view log
-- ============================================================
CREATE TABLE invoice_views (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    viewed_at       TIMESTAMPTZ DEFAULT NOW(),
    ip_address      INET,
    user_agent      TEXT,
    referrer        TEXT
);

-- ============================================================
-- Email log
-- ============================================================
CREATE TABLE email_log (
    id              SERIAL PRIMARY KEY,
    invoice_id      INTEGER REFERENCES invoices(id),
    type            TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    subject         TEXT,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    status          TEXT DEFAULT 'sent'
);

-- ============================================================
-- App settings (single row)
-- ============================================================
CREATE TABLE settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1,
    reminder_enabled        BOOLEAN DEFAULT TRUE,
    reminder_interval_days  INTEGER DEFAULT 7,
    max_reminders           INTEGER DEFAULT 3,
    default_payment_terms   INTEGER DEFAULT 30,
    default_currency        CHAR(3) DEFAULT 'EUR',
    default_vat_rate        NUMERIC(5,2) DEFAULT 19.00,
    default_payment_details TEXT,
    default_notes           TEXT,
    CONSTRAINT single_settings_row CHECK (id = 1)
);

INSERT INTO settings DEFAULT VALUES;
