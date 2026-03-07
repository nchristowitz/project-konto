require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

const COUNTRY_CODES = {
  'germany': 'DE',
  'united kingdom': 'GB',
  'switzerland': 'CH',
  'austria': 'AT',
  'canada': 'CA',
  'united states': 'US',
  'france': 'FR',
  'netherlands': 'NL',
  'italy': 'IT',
  'spain': 'ES',
  'sweden': 'SE',
  'denmark': 'DK',
  'norway': 'NO',
  'belgium': 'BE',
  'poland': 'PL',
  'czech republic': 'CZ',
  'ireland': 'IE',
  'portugal': 'PT',
  'luxembourg': 'LU',
};

// Simple CSV parser that handles quoted fields
function parseCSV(text) {
  const rows = [];
  let i = 0;

  while (i < text.length) {
    const row = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // Quoted field
        i++;
        let field = '';
        while (i < text.length) {
          if (text[i] === '"' && text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (text[i] === '"') {
            i++;
            break;
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }

      if (i < text.length && text[i] === ',') {
        i++;
      } else {
        break;
      }
    }
    // Skip line endings
    while (i < text.length && (text[i] === '\n' || text[i] === '\r')) i++;

    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  return rows;
}

async function importClients(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(text);
  const headers = rows[0];
  const data = rows.slice(1);

  // Map header names to indices
  const col = {};
  headers.forEach((h, i) => { col[h.trim()] = i; });

  // Build client objects
  const clients = data.map(row => {
    const org = (row[col['Organization']] || '').trim();
    const first = (row[col['First Name']] || '').trim();
    const last = (row[col['Last Name']] || '').trim();
    const country = (row[col['Country']] || '').trim().toLowerCase();

    return {
      name: org || `${first} ${last}`.trim(),
      contact_person: (first || last) ? `${first} ${last}`.trim() : null,
      email: (row[col['Email']] || '').trim() || null,
      phone: (row[col['Phone']] || '').replace(/'/g, '').trim() || null,
      address_line1: (row[col['Address Line 1']] || '').trim() || null,
      address_line2: (row[col['Address Line 2']] || '').trim() || null,
      city: (row[col['City']] || '').trim() || null,
      postal_code: (row[col['Postal Code']] || '').trim() || null,
      country_code: COUNTRY_CODES[country] || 'DE',
      notes: (row[col['Notes']] || '').trim() || null,
      _org: org, // keep for dedup
    };
  });

  // Merge multi-row orgs: first row becomes primary, extra emails + contacts collected
  const orgMap = new Map();
  const toImport = [];

  for (const c of clients) {
    if (c._org) {
      if (!orgMap.has(c._org)) {
        c.additional_emails = [];
        c.additional_contacts = [];
        orgMap.set(c._org, c);
      } else {
        const primary = orgMap.get(c._org);
        if (c.email && c.email !== primary.email && !primary.additional_emails.includes(c.email)) {
          primary.additional_emails.push(c.email);
        }
        if (c.contact_person && c.contact_person !== primary.contact_person) {
          primary.additional_contacts.push(c.contact_person);
        }
      }
    } else {
      c.additional_emails = [];
      c.additional_contacts = [];
      const key = c.name;
      if (!orgMap.has(key)) {
        orgMap.set(key, c);
      }
    }
  }

  for (const c of orgMap.values()) {
    // Append additional contact persons to notes
    if (c.additional_contacts.length) {
      const contactNote = `Additional contacts: ${c.additional_contacts.join(', ')}`;
      c.notes = c.notes ? `${c.notes}\n${contactNote}` : contactNote;
    }
    toImport.push(c);
  }

  const mergedOrgs = [...orgMap.values()].filter(c => c.additional_emails.length || c.additional_contacts.length);
  if (mergedOrgs.length) {
    console.log(`\nMerged ${mergedOrgs.length} orgs with multiple rows:`);
    mergedOrgs.forEach(c => console.log(`  - ${c.name} (+${c.additional_emails.length} emails, +${c.additional_contacts.length} contacts)`));
  }

  // Import (upsert by name — existing clients get additional_emails updated)
  console.log(`\nImporting ${toImport.length} clients:\n`);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const c of toImport) {
    const { rows: existing } = await pool.query(
      'SELECT id, additional_emails FROM clients WHERE name = $1', [c.name]
    );

    if (existing.length) {
      // Merge additional_emails into existing client
      const prev = existing[0].additional_emails || [];
      const allEmails = [...new Set([...prev, ...c.additional_emails])];
      // Also add the CSV primary email if it's different from what's stored and not already tracked
      if (c.email) {
        const { rows: cur } = await pool.query('SELECT email FROM clients WHERE id = $1', [existing[0].id]);
        if (cur[0].email !== c.email && !allEmails.includes(c.email)) {
          allEmails.push(c.email);
        }
      }
      if (allEmails.length !== prev.length) {
        await pool.query(
          'UPDATE clients SET additional_emails = $1, updated_at = NOW() WHERE id = $2',
          [allEmails, existing[0].id]
        );
        console.log(`  ~ ${c.name} (updated +${allEmails.length - prev.length} emails)`);
        updated++;
      } else {
        console.log(`  - ${c.name} (unchanged)`);
        skipped++;
      }
    } else {
      await pool.query(`
        INSERT INTO clients (
          name, contact_person, email, additional_emails,
          address_line1, address_line2, city, postal_code,
          country_code, notes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [
        c.name, c.contact_person, c.email, c.additional_emails,
        c.address_line1, c.address_line2, c.city, c.postal_code,
        c.country_code, c.notes,
      ]);
      console.log(`  + ${c.name}`);
      inserted++;
    }
  }

  console.log(`\nDone. ${inserted} inserted, ${updated} updated, ${skipped} unchanged.`);
  await pool.end();
}

const csvPath = process.argv[2] || path.join(__dirname, '..', 'clients.csv');
importClients(csvPath).catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
