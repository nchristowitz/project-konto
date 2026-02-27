const fs = require('fs');
const path = require('path');
const { InvoiceService } = require('@e-invoice-eu/core');
const { pool } = require('../db');
const { generateInvoicePdf } = require('./pdf');

function amt(value) {
  return Number(value).toFixed(2);
}

function buildUblInvoice({ invoice, lines, profile, client }) {
  const currency = invoice.currency || 'EUR';
  const isReverseCharge = invoice.reverse_charge;
  const vatCategory = isReverseCharge ? 'AE' : 'S';
  const vatRate = amt(invoice.vat_rate);

  // Build supplier party
  const supplierParty = {
    'cac:Party': {
      'cac:PartyName': { 'cbc:Name': profile.name || '' },
      'cac:PostalAddress': {
        'cbc:StreetName': profile.address_line1 || '',
        'cbc:CityName': profile.city || '',
        'cbc:PostalZone': profile.postal_code || '',
        'cac:Country': { 'cbc:IdentificationCode': profile.country_code || 'DE' },
      },
      'cac:PartyTaxScheme': [{
        'cbc:CompanyID': profile.vat_number || '',
        'cac:TaxScheme': { 'cbc:ID': 'VAT' },
      }],
      'cac:PartyLegalEntity': { 'cbc:RegistrationName': profile.name || '' },
    },
  };
  if (profile.address_line2) {
    supplierParty['cac:Party']['cac:PostalAddress']['cbc:AdditionalStreetName'] = profile.address_line2;
  }
  if (profile.email) {
    supplierParty['cac:Party']['cac:Contact'] = { 'cbc:ElectronicMail': profile.email };
  }

  // Build customer party
  const customerParty = {
    'cac:Party': {
      'cac:PartyName': { 'cbc:Name': client.name || '' },
      'cac:PostalAddress': {
        'cbc:StreetName': client.address_line1 || '',
        'cbc:CityName': client.city || '',
        'cbc:PostalZone': client.postal_code || '',
        'cac:Country': { 'cbc:IdentificationCode': client.country_code || 'DE' },
      },
      'cac:PartyLegalEntity': { 'cbc:RegistrationName': client.name || '' },
    },
  };
  if (client.address_line2) {
    customerParty['cac:Party']['cac:PostalAddress']['cbc:AdditionalStreetName'] = client.address_line2;
  }
  if (client.vat_number) {
    customerParty['cac:Party']['cac:PartyTaxScheme'] = [{
      'cbc:CompanyID': client.vat_number,
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    }];
  }

  // Build tax total
  const taxCategory = {
    'cbc:ID': vatCategory,
    'cac:TaxScheme': { 'cbc:ID': 'VAT' },
  };
  if (!isReverseCharge) {
    taxCategory['cbc:Percent'] = vatRate;
  } else {
    taxCategory['cbc:TaxExemptionReasonCode'] = 'vatex-eu-ae';
    taxCategory['cbc:TaxExemptionReason'] = 'Reverse charge';
  }

  const taxTotal = {
    'cbc:TaxAmount': amt(invoice.vat_amount),
    'cbc:TaxAmount@currencyID': currency,
    'cac:TaxSubtotal': [{
      'cbc:TaxableAmount': amt(invoice.subtotal),
      'cbc:TaxableAmount@currencyID': currency,
      'cbc:TaxAmount': amt(invoice.vat_amount),
      'cbc:TaxAmount@currencyID': currency,
      'cac:TaxCategory': taxCategory,
    }],
  };

  // Build monetary totals
  const totals = {
    'cbc:LineExtensionAmount': amt(invoice.subtotal),
    'cbc:LineExtensionAmount@currencyID': currency,
    'cbc:TaxExclusiveAmount': amt(invoice.subtotal),
    'cbc:TaxExclusiveAmount@currencyID': currency,
    'cbc:TaxInclusiveAmount': amt(invoice.total),
    'cbc:TaxInclusiveAmount@currencyID': currency,
    'cbc:PayableAmount': amt(invoice.total),
    'cbc:PayableAmount@currencyID': currency,
  };

  // Build payment means (bank transfer)
  const paymentMeans = [];
  if (profile.iban) {
    const pm = {
      'cbc:PaymentMeansCode': '30',
      'cac:PayeeFinancialAccount': {
        'cbc:ID': profile.iban,
      },
    };
    if (profile.bic) {
      pm['cac:PayeeFinancialAccount']['cac:FinancialInstitutionBranch'] = {
        'cbc:ID': profile.bic,
      };
    }
    paymentMeans.push(pm);
  }

  // Build invoice lines
  const invoiceLines = lines.map((line, idx) => {
    const lineItem = {
      'cbc:ID': String(idx + 1),
      'cbc:InvoicedQuantity': String(Number(line.quantity)),
      'cbc:InvoicedQuantity@unitCode': line.unit_code || 'C62',
      'cbc:LineExtensionAmount': amt(line.line_total),
      'cbc:LineExtensionAmount@currencyID': currency,
      'cac:Item': {
        'cbc:Name': line.description,
        'cac:ClassifiedTaxCategory': {
          'cbc:ID': vatCategory,
          'cbc:Percent': vatRate,
          'cac:TaxScheme': { 'cbc:ID': 'VAT' },
        },
      },
      'cac:Price': {
        'cbc:PriceAmount': amt(line.unit_price),
        'cbc:PriceAmount@currencyID': currency,
      },
    };
    if (line.detail) {
      lineItem['cbc:Note'] = line.detail;
    }
    return lineItem;
  });

  // Build full invoice
  const ublInvoice = {
    'ubl:Invoice': {
      'cbc:ID': invoice.number,
      'cbc:IssueDate': formatDate(invoice.issue_date),
      'cbc:InvoiceTypeCode': '380',
      'cbc:DocumentCurrencyCode': currency,
      'cac:AccountingSupplierParty': supplierParty,
      'cac:AccountingCustomerParty': customerParty,
      'cac:TaxTotal': [taxTotal],
      'cac:LegalMonetaryTotal': totals,
      'cac:InvoiceLine': invoiceLines,
    },
  };

  if (invoice.due_date) {
    ublInvoice['ubl:Invoice']['cbc:DueDate'] = formatDate(invoice.due_date);
  }

  if (invoice.notes) {
    ublInvoice['ubl:Invoice']['cbc:Note'] = [invoice.notes];
  }

  if (paymentMeans.length > 0) {
    ublInvoice['ubl:Invoice']['cac:PaymentMeans'] = paymentMeans;
  }

  return ublInvoice;
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

async function generateEInvoice(invoiceId) {
  // 1. Query invoice, lines, business_profile
  const { rows: invoiceRows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [invoiceId]
  );
  if (!invoiceRows.length) throw new Error('Invoice not found');
  const invoice = invoiceRows[0];

  const { rows: lineRows } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order', [invoiceId]
  );

  const { rows: profileRows } = await pool.query(
    'SELECT * FROM business_profile WHERE id = 1'
  );
  const profile = profileRows[0] || {};
  const client = invoice.client_snapshot || {};

  // 2. Generate visual PDF
  let statusWatermark = null;
  if (invoice.status === 'paid') statusWatermark = 'PAID';
  else if (invoice.status === 'cancelled') statusWatermark = 'CANCELLED';
  const pdfBytes = await generateInvoicePdf({ invoice, lines: lineRows, profile, client, statusWatermark });

  // 3. Build UBL invoice data
  const ublData = buildUblInvoice({ invoice, lines: lineRows, profile, client });

  // 4. Generate Factur-X PDF/A with embedded XML
  const invoiceService = new InvoiceService(console);
  const result = await invoiceService.generate(ublData, {
    format: 'Factur-X-EN16931',
    lang: 'en-gb',
    pdf: {
      buffer: new Uint8Array(pdfBytes),
      filename: `${invoice.number}.pdf`,
      mimetype: 'application/pdf',
    },
  });

  // 5. Write to disk
  const year = new Date(invoice.issue_date).getFullYear().toString();
  const filename = `${year}/${invoice.number}.pdf`;
  const dir = path.join(process.cwd(), 'data', 'invoices', year);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${invoice.number}.pdf`);
  fs.writeFileSync(filePath, Buffer.from(result));

  // 6. Update invoice record
  await pool.query(
    'UPDATE invoices SET pdf_filename = $1, updated_at = NOW() WHERE id = $2',
    [filename, invoiceId]
  );

  return { filename, path: filePath };
}

module.exports = { generateEInvoice };
