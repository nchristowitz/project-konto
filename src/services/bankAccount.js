'use strict';

function buildBankAccountSnapshot(row) {
  return {
    label: row.label || null,
    bank_name: row.bank_name || null,
    account_holder: row.account_holder || null,
    iban: row.iban || null,
    bic: row.bic || null,
    account_number: row.account_number || null,
    routing_number: row.routing_number || null,
    swift_code: row.swift_code || null,
  };
}

function formatPaymentDetails(snapshot) {
  if (!snapshot) return '';
  const lines = [];
  if (snapshot.account_holder) lines.push(`Account holder: ${snapshot.account_holder}`);
  if (snapshot.bank_name) lines.push(`Bank: ${snapshot.bank_name}`);
  if (snapshot.iban) lines.push(`IBAN: ${snapshot.iban}`);
  if (snapshot.bic) lines.push(`BIC: ${snapshot.bic}`);
  if (snapshot.account_number) lines.push(`Account: ${snapshot.account_number}`);
  if (snapshot.routing_number) lines.push(`Routing: ${snapshot.routing_number}`);
  if (snapshot.swift_code) lines.push(`SWIFT: ${snapshot.swift_code}`);
  return lines.join('\n');
}

module.exports = { buildBankAccountSnapshot, formatPaymentDetails };
