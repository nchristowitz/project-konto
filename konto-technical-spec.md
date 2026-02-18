# Invoicing App — Technical Specification

**Project name:** Konto
**Subdomain:** money.nicholaschristowitz.com
**Date:** February 2026


## 1. Overview

Konto is a self-hosted, single-user invoicing application for creating and managing invoices and estimates. It generates EU-compliant e-invoices (ZUGFeRD/Factur-X), sends them to clients via shareable links, tracks views, and automatically sends reminders for overdue invoices.

The application runs as a Docker container alongside your existing services on your Hetzner VPS.


## 2. Requirements Summary

### Must Have (Phase 1)
- Client management (add, edit, list)
- Invoice creation with line items, multi-currency (EUR, USD), configurable VAT rates per invoice
- Sequential invoice numbering (26001, 26002, ... resets each year)
- Invoice statuses: draft, sent, viewed, paid, partially paid, cancelled
- Record full and partial payments
- Shareable invoice links (public, no login required)
- View tracking (who viewed, when, how many times)
- Admin dashboard protected by username + password
- ZUGFeRD/Factur-X e-invoice generation (EN 16931 compliant)
- Due date tracking
- Send invoice to client via email with link
- Automatic overdue reminder emails
- Monospaced, utilitarian UI (same type size and weight throughout)

### Phase 2
- Estimates (creation, sending, convert to invoice)
- Optional password protection on individual invoice links
- Income reporting / simple analytics

### Out of Scope
- Multi-user / team features
- Recurring invoices
- Expense tracking
- Bank feed integration
- Tax filing


## 3. Architecture

```
                    Internet
                       │
                       ▼
              ┌─────────────────┐
              │      Caddy      │
              │  (reverse proxy │
              │   + auto SSL)   │
              └────────┬────────┘
                       │
         money.nicholaschristowitz.com
                       │
                       ▼
              ┌─────────────────┐
              │   Node.js App   │
              │   (port 3000)   │
              │                 │
              │  Express        │
              │  + EJS views    │
              │  + node-cron    │
              └───┬─────────┬───┘
                  │         │
         ┌────────┘         └────────┐
         ▼                           ▼
┌─────────────────┐        ┌─────────────────┐
│   PostgreSQL    │        │  Gmail SMTP     │
│  (existing)     │        │  (outbound      │
│                 │        │   email)        │
└─────────────────┘        └─────────────────┘
```

### Why Server-Rendered (not SPA)

Given the requirements — single user, utilitarian design, low interactivity — server-rendered HTML with EJS templates is the right fit. No build step, no client-side framework, fast page loads, and the monospaced aesthetic maps naturally to simple HTML. JavaScript is used only where genuinely needed (e.g., adding line items dynamically on the invoice form).


## 4. Tech Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | 22 LTS | Server |
| Framework | Express | 5.x | HTTP routing, middleware |
| Templates | EJS | 3.x | Server-rendered HTML |
| Database | PostgreSQL | 16 (existing) | Data storage |
| DB Client | pg (node-postgres) | 8.x | Database queries |
| Migrations | postgres-migrations | — | Schema versioning |
| E-invoice | @e-invoice-eu/core | latest | ZUGFeRD/Factur-X generation |
| Email | Nodemailer | 6.x | SMTP email sending |
| Auth | express-session + bcrypt | — | Session-based login |
| Scheduler | node-cron | 3.x | Daily overdue checks |
| CSS | Hand-written | — | Monospaced utilitarian theme |


## 5. Database Schema

All tables live in a dedicated `konto` schema within your existing PostgreSQL instance to keep things cleanly separated from SendRec's data.

```sql
CREATE SCHEMA IF NOT EXISTS konto;
SET search_path TO konto;

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
    vat_number      TEXT,               -- e.g. DE123456789
    tax_number      TEXT,               -- local Steuernummer
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
    vat_number      TEXT,               -- for reverse charge
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
    prefix          TEXT NOT NULL,       -- 'INV' or 'EST'
    year            INTEGER NOT NULL,
    next_number     INTEGER DEFAULT 1,
    UNIQUE(prefix, year)
);

-- ============================================================
-- Invoices
-- ============================================================
CREATE TABLE invoices (
    id              SERIAL PRIMARY KEY,
    number          TEXT UNIQUE NOT NULL, -- e.g. 26005, 27001

    -- Client reference
    client_id       INTEGER NOT NULL REFERENCES clients(id),

    -- Snapshot of client details at time of invoice creation
    -- (so editing the client later doesn't change historical invoices)
    client_snapshot JSONB NOT NULL,

    -- Dates
    issue_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date        DATE,

    -- Currency & tax
    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    vat_rate        NUMERIC(5,2) NOT NULL DEFAULT 19.00,
    vat_label       TEXT DEFAULT 'VAT',  -- 'VAT', 'USt', 'N/A', etc.
    vat_note        TEXT,                -- e.g. "Reverse charge: VAT to be
                                         -- accounted for by the recipient"
    reverse_charge  BOOLEAN DEFAULT FALSE,

    -- Calculated totals (denormalized for quick reads)
    subtotal        NUMERIC(12,2) DEFAULT 0,
    vat_amount      NUMERIC(12,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    amount_paid     NUMERIC(12,2) DEFAULT 0,

    -- Status
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

    -- Public sharing
    view_token      TEXT UNIQUE NOT NULL, -- random URL-safe token
    view_password   TEXT,                 -- bcrypt hash (Phase 2, nullable)
    first_viewed_at TIMESTAMPTZ,
    last_viewed_at  TIMESTAMPTZ,
    view_count      INTEGER DEFAULT 0,

    -- E-invoice files
    einvoice_format TEXT DEFAULT 'ZUGFeRD',
    pdf_filename    TEXT,                 -- stored on disk

    -- Email / reminders
    last_reminder_at TIMESTAMPTZ,
    reminder_count  INTEGER DEFAULT 0,

    -- Notes & payment
    payment_details TEXT,                -- free-text bank details shown on invoice
    notes           TEXT,                -- shown on invoice below payment details
    internal_notes  TEXT,                -- admin only, never shown to client
    footer_text     TEXT,                -- small print at bottom

    -- Timestamps
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
    detail          TEXT,               -- optional longer description below title
    quantity        NUMERIC(10,3) NOT NULL DEFAULT 1,
    unit_code       TEXT DEFAULT 'HUR',  -- EN 16931 unit codes:
                                         -- HUR=hours, DAY=days, EA=each,
                                         -- MON=months, C62=units
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
    method          TEXT,                -- 'bank_transfer', 'cash', 'paypal', etc.
    reference       TEXT,                -- transaction ref / note
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
    type            TEXT NOT NULL,        -- 'invoice_sent', 'reminder',
                                         -- 'estimate_sent'
    recipient       TEXT NOT NULL,
    subject         TEXT,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    status          TEXT DEFAULT 'sent'   -- 'sent', 'failed'
);

-- ============================================================
-- App settings (single row for app config)
-- ============================================================
CREATE TABLE settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1,
    reminder_enabled        BOOLEAN DEFAULT TRUE,
    reminder_interval_days  INTEGER DEFAULT 7,   -- days between reminders
    max_reminders           INTEGER DEFAULT 3,
    default_payment_terms   INTEGER DEFAULT 30,  -- days
    default_currency        CHAR(3) DEFAULT 'EUR',
    default_vat_rate        NUMERIC(5,2) DEFAULT 19.00,
    default_payment_details TEXT,                 -- pre-filled on new invoices
                                                 -- e.g. bank name, IBAN, BIC
    default_notes           TEXT,                 -- pre-filled notes for invoices
    CONSTRAINT single_settings_row CHECK (id = 1)
);

INSERT INTO settings DEFAULT VALUES;
```

### Key Design Decisions

**Client snapshot on invoices**: When you create an invoice, the client's name, address, and VAT number are copied into a `client_snapshot` JSONB field. This means if you later update a client's address, existing invoices remain historically accurate.

**Separate `konto` schema**: Keeps all tables namespaced away from SendRec's tables in the same PostgreSQL instance. No risk of collision.

**`view_token`**: A cryptographically random, URL-safe string (e.g., 32 hex chars). Generated at invoice creation time. Used in the public URL: `money.nicholaschristowitz.com/i/{view_token}`.

**VAT flexibility**: Each invoice has its own `vat_rate`, `vat_label`, `vat_note`, and `reverse_charge` flag. This lets you handle:
- German domestic: 19% VAT / 7% reduced
- EU reverse charge: 0%, with note
- Non-EU clients: 0%, with note
- USD invoices: 0% or whatever applies

**Payment details per invoice**: The `settings` table stores your `default_payment_details` (e.g., your primary bank account). When you create a new invoice, this is pre-filled into the invoice's `payment_details` field — but you can edit it per invoice. This supports your use case of 2-3 different bank accounts and payment methods without needing a separate "payment methods" management system. Just edit the text on each invoice.

**Line item detail**: Each line item has a `description` (the title, e.g., "Website redesign") and an optional `detail` field for longer explanatory text that renders below the title on the invoice. This keeps the line items table scannable while allowing detailed scope descriptions.


## 6. Sequential Invoice Numbering

Format: `{YY}{NNN}` — two-digit year + three-digit sequential number.

Examples: `26001`, `26002`, `26005`, `27001`

The sequence resets to 001 at the start of each calendar year. You're currently on invoice 4 for 2026, so the next invoice will be `26005`.

```javascript
async function getNextInvoiceNumber(prefix = 'INV') {
    const year = new Date().getFullYear();
    const yy = String(year).slice(-2);

    // Upsert the sequence row, then increment and return atomically
    const result = await db.query(`
        INSERT INTO konto.invoice_sequences (prefix, year, next_number)
        VALUES ($1, $2, 1)
        ON CONFLICT (prefix, year)
        DO UPDATE SET next_number = konto.invoice_sequences.next_number + 1
        RETURNING next_number - 1 AS current_number
    `, [prefix, year]);

    const num = result.rows[0].current_number || 1;
    return `${yy}${String(num).padStart(3, '0')}`;
}
```

On initial deployment, we seed the sequence so it picks up at 005:
```sql
INSERT INTO konto.invoice_sequences (prefix, year, next_number)
VALUES ('INV', 2026, 5);
```

The `ON CONFLICT ... DO UPDATE` ensures atomicity — no race conditions even if you somehow trigger two invoice creations simultaneously.

### Numbering Lifecycle & Gaps

The sequence number is assigned when the invoice is first saved (as a draft). If a draft is later cancelled, the number stays — cancelled invoices are retained in the system, never deleted. This is standard accounting practice and avoids the complexity of deferred numbering while remaining GoBD-compliant. Unexplained gaps (where an invoice number simply doesn't exist) are what triggers audit flags — a cancelled invoice with a number is a perfectly normal, documented record.


## 7. Authentication

Single-user, session-based authentication. No registration flow — credentials are set via environment variables.

```
ADMIN_USERNAME=nicholas
ADMIN_PASSWORD_HASH=$2b$10$... (bcrypt hash)
```

You generate the hash once:
```bash
node -e "const bcrypt = require('bcrypt'); bcrypt.hash('yourpassword', 10).then(h => console.log(h))"
```

### Session Setup
```javascript
// Trust Caddy reverse proxy (required for correct req.ip and secure cookies)
app.set('trust proxy', 1);

app.use(session({
    store: new PgStore({
        pool: db,
        schemaName: 'konto',
        tableName: 'sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,      // HTTPS only (Caddy handles SSL)
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
        sameSite: 'lax'
    }
}));
```

### Auth Middleware
```javascript
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.redirect('/login');
}

// Apply to all admin routes
app.use('/dashboard', requireAuth);
app.use('/clients', requireAuth);
app.use('/invoices', requireAuth);
app.use('/api', requireAuth);
```

Public routes (`/i/:token`, `/i/:token/pdf`) are NOT behind auth.


## 8. Routes

### Public Routes (no auth)
```
GET  /login                     Login form
POST /login                     Authenticate
GET  /logout                    Destroy session

GET  /i/:token                  View invoice (public page)
GET  /i/:token/pdf              Download PDF
```

### Admin Routes (auth required)
```
GET  /dashboard                 Overview: recent invoices, overdue, income

GET  /clients                   Client list
GET  /clients/new               New client form
POST /clients                   Create client
GET  /clients/:id               Edit client form
POST /clients/:id               Update client
POST /clients/:id/archive       Archive client

GET  /invoices                  Invoice list (filterable by status, client, date)
GET  /invoices/new              New invoice form
GET  /invoices/new?client=:id   New invoice form pre-filled with client
POST /invoices                  Create invoice
GET  /invoices/:id              View / edit invoice
POST /invoices/:id              Update invoice
POST /invoices/:id/send         Send invoice email to client
POST /invoices/:id/remind       Manually send reminder
POST /invoices/:id/status       Update status (mark paid, cancel, etc.)
POST /invoices/:id/payments     Record a payment
DELETE /invoices/:id/payments/:pid  Remove a payment

GET  /settings                  App settings + business profile
POST /settings                  Update settings
POST /settings/profile          Update business profile
```


## 9. E-Invoice Generation (ZUGFeRD)

### Why ZUGFeRD

ZUGFeRD (identical to Factur-X) produces a PDF/A-3 document with the EN 16931 XML embedded as an attachment. This gives you:
- A human-readable PDF your clients can open in any PDF viewer
- Machine-readable structured XML for compliance
- Full EN 16931 conformance for the German e-invoicing mandate

### Integration with @e-invoice-eu/core

The library accepts invoice data as JSON and outputs the ZUGFeRD PDF. Here's the mapping from our data model to the library's expected format:

```javascript
const { InvoiceService } = require('@e-invoice-eu/core');

async function generateEInvoice(invoice, lines, businessProfile) {
    const invoiceService = new InvoiceService(console);

    const invoiceData = {
        'ubl:Invoice': {
            'cbc:ID': invoice.number,           // e.g. '26005'
            'cbc:IssueDate': invoice.issue_date,   // YYYY-MM-DD
            'cbc:DueDate': invoice.due_date,
            'cbc:InvoiceTypeCode': '380',           // Commercial invoice
            'cbc:DocumentCurrencyCode': invoice.currency,

            // Seller (you)
            'cac:AccountingSupplierParty': {
                'cac:Party': {
                    'cac:PartyName': {
                        'cbc:Name': businessProfile.name
                    },
                    'cac:PostalAddress': {
                        'cbc:StreetName': businessProfile.address_line1,
                        'cbc:CityName': businessProfile.city,
                        'cbc:PostalZone': businessProfile.postal_code,
                        'cac:Country': {
                            'cbc:IdentificationCode': businessProfile.country_code
                        }
                    },
                    'cac:PartyTaxScheme': {
                        'cbc:CompanyID': businessProfile.vat_number,
                        'cac:TaxScheme': { 'cbc:ID': 'VAT' }
                    }
                }
            },

            // Buyer (client)
            'cac:AccountingCustomerParty': {
                'cac:Party': {
                    'cac:PartyName': {
                        'cbc:Name': invoice.client_snapshot.name
                    },
                    'cac:PostalAddress': {
                        'cbc:StreetName': invoice.client_snapshot.address_line1,
                        'cbc:CityName': invoice.client_snapshot.city,
                        'cbc:PostalZone': invoice.client_snapshot.postal_code,
                        'cac:Country': {
                            'cbc:IdentificationCode':
                                invoice.client_snapshot.country_code
                        }
                    }
                    // PartyTaxScheme included only if client has VAT number
                }
            },

            // Payment means
            'cac:PaymentMeans': {
                'cbc:PaymentMeansCode': '58',       // SEPA credit transfer
                'cac:PayeeFinancialAccount': {
                    'cbc:ID': businessProfile.iban,
                    'cbc:Name': businessProfile.name,
                    'cac:FinancialInstitutionBranch': {
                        'cbc:ID': businessProfile.bic
                    }
                }
            },

            // Payment terms
            'cac:PaymentTerms': {
                'cbc:Note': invoice.due_date
                    ? `Due by ${invoice.due_date}`
                    : 'Due on receipt'
            },

            // Tax summary
            'cac:TaxTotal': {
                'cbc:TaxAmount': invoice.vat_amount,
                'cac:TaxSubtotal': {
                    'cbc:TaxableAmount': invoice.subtotal,
                    'cbc:TaxAmount': invoice.vat_amount,
                    'cac:TaxCategory': {
                        'cbc:ID': determineTaxCategoryCode(invoice),
                        'cbc:Percent': invoice.vat_rate,
                        'cac:TaxScheme': { 'cbc:ID': 'VAT' }
                    }
                }
            },

            // Totals
            'cac:LegalMonetaryTotal': {
                'cbc:LineExtensionAmount': invoice.subtotal,
                'cbc:TaxExclusiveAmount': invoice.subtotal,
                'cbc:TaxInclusiveAmount': invoice.total,
                'cbc:PayableAmount': invoice.total - invoice.amount_paid
            },

            // Line items
            'cac:InvoiceLine': lines.map((line, i) => ({
                'cbc:ID': String(i + 1),
                'cbc:InvoicedQuantity': {
                    '#text': line.quantity,
                    '@unitCode': line.unit_code
                },
                'cbc:LineExtensionAmount': line.line_total,
                'cac:Item': {
                    'cbc:Name': line.description,
                    'cac:ClassifiedTaxCategory': {
                        'cbc:ID': determineTaxCategoryCode(invoice),
                        'cbc:Percent': invoice.vat_rate,
                        'cac:TaxScheme': { 'cbc:ID': 'VAT' }
                    }
                },
                'cac:Price': {
                    'cbc:PriceAmount': line.unit_price
                }
            }))
        }
    };

    const result = await invoiceService.generate(invoiceData, {
        format: 'Factur-X-EN16931',
        lang: 'en'
    });

    return result; // Contains the PDF buffer
}

// EN 16931 tax category codes
function determineTaxCategoryCode(invoice) {
    if (invoice.reverse_charge) return 'AE';  // Reverse charge
    if (invoice.vat_rate === 0) return 'O';    // Not subject to VAT
    if (invoice.vat_rate < 19) return 'AA';    // Reduced rate
    return 'S';                                 // Standard rate
}
```

### PDF Generation Approach

We let `@e-invoice-eu/core` handle the entire PDF generation — both the visual layout and the embedded EN 16931 XML. The library produces a ZUGFeRD/Factur-X PDF/A-3 document with the XML already attached.

The PDF layout will be functional but generic (the library controls the visual output, not us). Given the utilitarian aesthetic we're going for, this is acceptable. The web view of the invoice (the public `/i/:token` page) is what clients will primarily interact with — the PDF is for download/archival.

```javascript
const { InvoiceService } = require('@e-invoice-eu/core');

async function generateInvoicePDF(invoiceData) {
    const invoiceService = new InvoiceService(console);

    const result = await invoiceService.generate(invoiceData, {
        format: 'Factur-X-EN16931',
        lang: 'en'
    });

    return result; // Contains the PDF buffer with embedded XML
}
```

**Fallback plan**: If the library's PDF output is unusable (wrong data, broken layout, or doesn't actually embed the XML correctly), we fall back to building the PDF with `pdf-lib` — a lightweight JavaScript library (~1MB) that lets us construct the PDF programmatically and attach the XML ourselves. This decision happens at Step 7 when we can evaluate the actual output.

### PDF Storage

Generated PDFs are stored at:
```
/app/data/invoices/{year}/{number}.pdf
```
e.g. `/app/data/invoices/2026/26005.pdf`

This directory is a Docker volume for persistence. The `pdf_filename` column stores the relative path.

### Important Note

The exact JSON structure accepted by `@e-invoice-eu/core` may differ from what I've shown above — I've mapped it based on their documentation, but we should verify against their schema and sample files when we integrate. The library also has a built-in JSON schema validation, so we'll get clear errors if something's wrong. I want to flag this upfront rather than pretend the mapping is guaranteed correct.


## 10. Email

### Configuration

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=hello@nicholaschristowitz.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx           # Google App Password
EMAIL_FROM="Nicholas Christowitz <hello@nicholaschristowitz.com>"
```

Since you have a Google Workspace account, emails sent via SMTP will correctly show as coming from `hello@nicholaschristowitz.com`.

### Email Templates

Plain text emails (no fancy HTML — matches the utilitarian aesthetic). Three templates:

**Invoice sent:**
```
Subject: Invoice {number} from Nicholas Christowitz

Hi {client_contact_or_name},

Please find invoice {number} for {currency} {total}.

View online: {link}
Due date: {due_date}

Best regards,
Nicholas Christowitz
```

**Reminder:**
```
Subject: Reminder: Invoice {number} is overdue

Hi {client_contact_or_name},

This is a friendly reminder that invoice {number} for {currency} {total}
was due on {due_date}.

View online: {link}

If you've already made payment, please disregard this message.

Best regards,
Nicholas Christowitz
```

**Estimate sent (Phase 2):**
```
Subject: Estimate {number} from Nicholas Christowitz
...
```

### Overdue Reminder Cron

Runs daily at 9:00 AM CET:

```javascript
const cron = require('node-cron');

// Every day at 09:00 Europe/Berlin
cron.schedule('0 9 * * *', async () => {
    const settings = await getSettings();
    if (!settings.reminder_enabled) return;

    const overdueInvoices = await db.query(`
        SELECT i.*, c.email as client_email, c.name as client_name
        FROM konto.invoices i
        JOIN konto.clients c ON i.client_id = c.id
        WHERE i.status IN ('sent', 'viewed')
          AND i.due_date < CURRENT_DATE
          AND i.reminder_count < $1
          AND (
              i.last_reminder_at IS NULL
              OR i.last_reminder_at < NOW() - INTERVAL '1 day' * $2
          )
    `, [settings.max_reminders, settings.reminder_interval_days]);

    for (const invoice of overdueInvoices.rows) {
        try {
            await sendReminderEmail(invoice);
            await db.query(`
                UPDATE konto.invoices
                SET reminder_count = reminder_count + 1,
                    last_reminder_at = NOW(),
                    status = 'overdue',
                    updated_at = NOW()
                WHERE id = $1
            `, [invoice.id]);
        } catch (err) {
            // Log failure but continue to next invoice
            console.error(`Reminder failed for invoice ${invoice.number}:`, err);
            await db.query(`
                INSERT INTO konto.email_log (invoice_id, type, recipient, subject, status)
                VALUES ($1, 'reminder', $2, $3, 'failed')
            `, [invoice.id, invoice.client_email,
                `Reminder: Invoice ${invoice.number} is overdue`]);
        }
    }
}, { timezone: 'Europe/Berlin' });
```


## 11. Public Invoice View

### Route: GET /i/:token

This is what your clients see when they click the invoice link. It renders a clean HTML version of the invoice — not a PDF embed, but a proper web page that looks like an invoice.

### View Tracking (Bot-Resistant)

Email security scanners (Google Workspace, Microsoft 365, Apple Mail) automatically pre-fetch links in emails to scan for malware. If we logged a view on every `GET /i/:token`, every invoice would show as "viewed" within seconds of being sent — defeating the purpose.

Instead, view tracking is triggered client-side:

1. The page loads normally (the `GET` request renders the invoice HTML)
2. A small inline `<script>` fires a `POST /api/views/:token` request after a short delay
3. The server logs the view only on this POST request

```javascript
// In the public invoice EJS template
<script>
    // Fire after 2 seconds — bots don't execute JS, humans do
    setTimeout(() => {
        fetch('/api/views/<%= invoice.view_token %>', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    }, 2000);
</script>
```

The POST handler:
1. Logs the view in `invoice_views` (IP, user agent, timestamp)
2. Updates `view_count`, `last_viewed_at` on the invoice
3. If `first_viewed_at` is null, sets it
4. If status is `sent`, updates to `viewed`

### View Tracking Privacy

Only IP address and user agent are stored (no cookies, no tracking scripts beyond the beacon above). This is enough to give you a sense of whether the client has seen the invoice without being invasive.


## 12. Docker Setup

### Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Directory for generated PDFs
RUN mkdir -p /app/data/invoices

EXPOSE 3000

CMD ["node", "src/server.js"]
```

### Addition to ~/services/docker-compose.yml

```yaml
  konto:
    build: ./konto
    container_name: konto
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://konto:${KONTO_DB_PASSWORD}@postgres:5432/sendrec
      - DB_SCHEMA=konto
      - SESSION_SECRET=${KONTO_SESSION_SECRET}
      - ADMIN_USERNAME=${KONTO_ADMIN_USERNAME}
      - ADMIN_PASSWORD_HASH=${KONTO_ADMIN_PASSWORD_HASH}
      - SMTP_HOST=smtp.gmail.com
      - SMTP_PORT=465
      - SMTP_SECURE=true
      - SMTP_USER=${KONTO_SMTP_USER}
      - SMTP_PASS=${KONTO_SMTP_PASS}
      - EMAIL_FROM=${KONTO_EMAIL_FROM}
      - BASE_URL=https://money.nicholaschristowitz.com
      - TZ=Europe/Berlin
    volumes:
      - konto-data:/app/data
    depends_on:
      - postgres
    networks:
      - internal

volumes:
  konto-data:
```

Note: We reuse the existing PostgreSQL container but with a dedicated `konto` schema and a separate database user. The database name (`sendrec` or whatever it's currently called) stays the same — schemas provide the isolation.

### Addition to ~/services/caddy/Caddyfile

```
money.nicholaschristowitz.com {
    reverse_proxy konto:3000
}
```

### Addition to ~/services/.env

```env
KONTO_DB_PASSWORD=<generate>
KONTO_SESSION_SECRET=<generate>
KONTO_ADMIN_USERNAME=nicholas
KONTO_ADMIN_PASSWORD_HASH=<bcrypt hash>
KONTO_SMTP_USER=hello@nicholaschristowitz.com
KONTO_SMTP_PASS=<google app password>
KONTO_EMAIL_FROM=Nicholas Christowitz <hello@nicholaschristowitz.com>
```


## 13. File Structure

```
~/services/konto/
├── Dockerfile
├── package.json
├── src/
│   ├── server.js               # Express app entry point
│   ├── config.js               # Environment variable parsing
│   ├── db.js                   # PostgreSQL pool + query helper
│   ├── auth.js                 # Login, session, middleware
│   │
│   ├── routes/
│   │   ├── dashboard.js        # GET /dashboard
│   │   ├── clients.js          # /clients CRUD
│   │   ├── invoices.js         # /invoices CRUD + send/remind
│   │   ├── public.js           # /i/:token (public view)
│   │   └── settings.js         # /settings
│   │
│   ├── services/
│   │   ├── invoiceNumber.js    # Sequential numbering logic
│   │   ├── einvoice.js         # ZUGFeRD PDF generation via @e-invoice-eu/core
│   │   ├── email.js            # Nodemailer setup + templates
│   │   ├── reminder.js         # Overdue cron job
│   │   └── viewTracker.js      # View logging
│   │
│   ├── views/
│   │   ├── layout.ejs          # Base layout (head, nav, footer)
│   │   ├── login.ejs
│   │   ├── dashboard.ejs
│   │   ├── clients/
│   │   │   ├── index.ejs       # Client list
│   │   │   └── form.ejs        # New / edit client
│   │   ├── invoices/
│   │   │   ├── index.ejs       # Invoice list
│   │   │   ├── form.ejs        # New / edit invoice
│   │   │   └── show.ejs        # Invoice detail (admin view)
│   │   ├── public/
│   │   │   └── invoice.ejs     # Public invoice view
│   │   └── settings.ejs
│   │
│   └── public/
│       ├── style.css           # The one CSS file
│       └── invoice-form.js     # Dynamic line item handling
│
├── migrations/
│   ├── 001-initial-schema.sql
│   └── ...
│
└── data/                       # Docker volume mount point
    └── invoices/               # Generated PDFs
        └── 2026/
            └── INV-2026-0001.pdf
```


## 14. UI Design

### Two Distinct Aesthetics

The app has two visual modes:

1. **Dashboard / Admin UI** — Clean, neutral, Notion/Linear-inspired. A proper UI with a readable sans-serif font, good spacing, subtle borders, and functional layout.
2. **Invoice document** — Monospaced, utilitarian. This is what clients see (both on the web and as the PDF). A proper A4 invoice layout with aligned columns, clear structure, and a professional feel.

### Dashboard Aesthetic (Admin)

```css
:root {
    --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
    --text: #1a1a1a;
    --text-secondary: #6b7280;
    --bg: #ffffff;
    --bg-subtle: #f9fafb;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
    --success: #16a34a;
    --warning: #d97706;
    --radius: 6px;
    --size: 14px;
}

body {
    font-family: var(--font);
    font-size: var(--size);
    line-height: 1.5;
    color: var(--text);
    background: var(--bg-subtle);
}
```

Characteristics:
- Inter (or system sans-serif) for the dashboard, with monospace only for invoice numbers and amounts
- Light background, white content cards
- Minimal borders, generous whitespace
- Status badges as subtle colored text (no heavy pills)
- Tables with light row separators, no outer borders
- Navigation as a clean horizontal bar or minimal sidebar

### Status Display (Dashboard)

Statuses rendered as subtle colored text:
- **Draft** — gray
- **Sent** — default text color
- **Viewed** — blue
- **Paid** — green
- **Partial** — amber/orange
- **Overdue** — red
- **Cancelled** — gray, strikethrough

### Dashboard Layout

```
┌──────────────────────────────────────────────────────┐
│  Konto          Clients    Invoices    Settings       │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Overdue                                             │
│  ┌────────────────────────────────────────────────┐  │
│  │ 26004    Acme Corp       $4,200.00   Jan 28    │  │
│  │ 26002    Design Co       €1,800.00   Feb 01    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Recent Invoices                        + New        │
│  ┌────────────────────────────────────────────────┐  │
│  │ 26005    New Client      €3,500.00   Mar 01  ● │  │
│  │ 26004    Acme Corp       $4,200.00   Jan 28  ● │  │
│  │ 26003    Studio XY       €950.00     Feb 14  ● │  │
│  │ 26002    Design Co       €1,800.00   Feb 01  ● │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  This Month         This Year                        │
│  Invoiced  €8,250   Invoiced  €24,300                │
│  Received  €950     Received  €18,500                │
│  Pending   €7,300   Pending   €5,800                 │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Invoice Form (Admin)

The form for creating/editing invoices. Line items are added dynamically with JavaScript.

Key additions based on requirements:
- Line item descriptions can have a secondary description/detail line below them
- A free-text "Payment details" area for banking info (editable per invoice, pre-filled from a saved default)
- A "Notes" area at the bottom

```
┌──────────────────────────────────────────────────────┐
│  New Invoice                                         │
│                                                      │
│  Client          [▼ Select client_______________]    │
│  Currency        [EUR ▼]                             │
│  Issue date      [2026-02-13]                        │
│  Due date        [2026-03-15]                        │
│                                                      │
│  VAT rate        [19.00] %                           │
│  VAT label       [USt__]                             │
│  □ Reverse charge                                    │
│  VAT note        [________________________________]  │
│                                                      │
│  ─ Items ──────────────────────────────────────────  │
│                                                      │
│  Description                    Qty  Unit   Rate     │
│  ┌──────────────────────────────────────────────┐    │
│  │ Website redesign                              │   │
│  │ [Detailed description of the redesign work    │   │
│  │  including responsive layouts and CMS setup]  │   │
│  │                              1    hr    85.00 │   │
│  ├──────────────────────────────────────────────┤    │
│  │ Logo concepts                                 │   │
│  │ [Three initial concepts plus two rounds of    │   │
│  │  revisions]                                   │   │
│  │                              3    ea   200.00 │   │
│  └──────────────────────────────────────────────┘    │
│  + Add item                                          │
│                                                      │
│  ─ Payment Details ────────────────────────────────  │
│  [Bank transfer:                                  ]  │
│  [Nicholas Christowitz                            ]  │
│  [IBAN: DE89 3704 0044 0532 0130 00               ]  │
│  [BIC: COBADEFFXXX                                ]  │
│  (pre-filled from defaults, editable per invoice)    │
│                                                      │
│  ─ Notes ──────────────────────────────────────────  │
│  [Thank you for your business.                    ]  │
│                                                      │
│  ─ Internal Notes ─────────────────────────────────  │
│  [Discussed scope on 2026-02-10 call]  (not shown)  │
│                                                      │
│  [Save draft]    [Save & send]                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Invoice Document (Web + PDF) — A4 Layout

This is what clients see. Same layout renders as the web view AND as the generated PDF. Monospaced font, proper A4 proportions, a real invoice.

The layout uses a clean table for line items with right-aligned amounts, and supports longer descriptions under each item.

```
┌─ A4 ─────────────────────────────────────────────────┐
│                                                      │
│  Nicholas Christowitz                                │
│  Musterstraße 1                                      │
│  10115 Berlin, DE                                    │
│  VAT: DE123456789                                    │
│  hello@nicholaschristowitz.com                       │
│                                                      │
│                                                      │
│  INVOICE 26005                                       │
│                                                      │
│  Bill to:                                            │
│  Acme Corp                                           │
│  123 Business St                                     │
│  New York, NY 10001, US                              │
│                                                      │
│  Date:       2026-02-13                              │
│  Due:        2026-03-15                              │
│                                                      │
│  ────────────────────────────────────────────────    │
│                                                      │
│  Description                         Qty     Amount  │
│  ────────────────────────────────────────────────    │
│                                                      │
│  Website redesign                                    │
│  Detailed description of the          1 hr    85.00  │
│  redesign work including responsive                  │
│  layouts and CMS setup                               │
│                                                      │
│  Logo concepts                                       │
│  Three initial concepts plus two      3 ea   600.00  │
│  rounds of revisions                                 │
│                                                      │
│  ────────────────────────────────────────────────    │
│                                   Subtotal   685.00  │
│                                   VAT 0%       0.00  │
│                                   ───────────────    │
│                                   Total USD  685.00  │
│                                                      │
│                                                      │
│  Payment details:                                    │
│  Bank transfer to:                                   │
│  Nicholas Christowitz                                │
│  IBAN: DE89 3704 0044 0532 0130 00                   │
│  BIC: COBADEFFXXX                                    │
│                                                      │
│                                                      │
│  Thank you for your business.                        │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Key layout principles:
- Monospaced font (JetBrains Mono) throughout the invoice document
- A4 proportions (210mm × 297mm)
- Line items in a proper table with right-aligned amounts
- Item descriptions can wrap to multiple lines below the item title
- Quantities and amounts align to a right column
- Subtotal / VAT / Total block right-aligned at the bottom
- Payment details section is free-text (you choose what goes here per invoice)
- Notes section at the very bottom
- The web view wraps this in a minimal page with a "Download PDF" link at top
- The PDF is generated to look identical to this web view


## 15. Build Sequence

### Step 1: Infrastructure setup
- Create `~/services/konto/` directory on server
- Add DNS A record for `money.nicholaschristowitz.com`
- Add Caddy config
- Create PostgreSQL user and schema
- Set environment variables in `.env`

### Step 2: Core app scaffold
- Express app with EJS
- Database connection + migration runner
- Run initial migration
- Session auth (login/logout)
- Base layout template with nav

### Step 3: Business profile + settings
- Settings page
- Business profile form
- Seed initial data

### Step 4: Client management
- Client list, create, edit, archive
- Default currency/VAT per client

### Step 5: Invoice creation + editing
- Invoice form with dynamic line items
- Sequential numbering
- Total calculation (server-side)
- Save as draft
- Invoice list with filters
- Invoice detail view (admin)

### Step 6: Public invoice view + tracking
- Public route with token
- HTML invoice rendering
- View logging
- Status auto-update (sent → viewed)

### Step 7: PDF + e-invoice generation
- Integrate @e-invoice-eu/core
- Generate ZUGFeRD PDF on invoice finalization
- Store PDF, serve on download

### Step 8: Email sending
- Nodemailer setup with Gmail
- Send invoice email
- Email logging

### Step 9: Overdue reminders
- Cron job
- Reminder email template
- Reminder tracking (count, last sent)

### Step 10: Payments
- Record payment form
- Partial payment logic
- Auto-update status (paid / partially_paid)

### Step 11: Polish
- Dashboard summary stats
- Error handling throughout
- Input validation
- Edge cases (zero-amount invoices, very long descriptions, etc.)


## 16. Deployment Checklist

Before going live:

- [ ] DNS A record added at Infomaniak for `money.nicholaschristowitz.com`
- [ ] PostgreSQL user `konto` created with password
- [ ] `konto` schema created
- [ ] All `KONTO_*` env vars added to `~/services/.env`
- [ ] Google App Password generated for `hello@nicholaschristowitz.com`
- [ ] Admin password bcrypt hash generated and set
- [ ] Session secret generated (`openssl rand -hex 32`)
- [ ] Docker image builds successfully
- [ ] Caddy config updated and reloaded
- [ ] Test login works
- [ ] Test invoice creation
- [ ] Test email sending (send test invoice to yourself)
- [ ] Test public link + view tracking
- [ ] Test PDF download
- [ ] Verify ZUGFeRD XML is embedded in PDF (open in Adobe Acrobat, check attachments)


## 17. Open Items / Caveats

1. **@e-invoice-eu/core integration**: The JSON structure I've shown in Section 9 is my best mapping from their docs, but it needs to be tested against the actual library. The library's internal format may require adjustments. We'll validate this during Step 7.

2. **PDF output quality**: The `@e-invoice-eu/core` library controls the PDF layout. If its output is too generic or broken, we fall back to `pdf-lib` for programmatic PDF construction — a lightweight alternative that gives us full layout control without Puppeteer/Chromium.

3. **Gmail sending limits**: Gmail allows roughly 500 emails per day on Workspace accounts. More than enough for invoicing, but worth knowing. If you ever need higher volume, we'd switch to a dedicated transactional email service.

4. **Backups**: Your invoice data will be in PostgreSQL (already on your server) and PDF files in a Docker volume. You should set up a regular backup — even a simple cron job that dumps the database and rsyncs the volume to another location. We can set this up as part of the project.

5. **Server resources**: Your cpx11 (2 vCPU, 4GB RAM) should handle this fine alongside existing services. The app is lightweight — no heavy computation. If memory does get tight, a simple upgrade to cpx21 (~€8/month) doubles the RAM.
