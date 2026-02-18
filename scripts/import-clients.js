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

  // Count occurrences of each org name
  const orgCounts = {};
  for (const c of clients) {
    if (c._org) {
      orgCounts[c._org] = (orgCounts[c._org] || 0) + 1;
    }
  }

  // Filter: skip orgs that appear more than once, keep unique orgs + individuals
  const seen = new Set();
  const toImport = [];
  for (const c of clients) {
    if (c._org && orgCounts[c._org] > 1) continue; // skip duplicates
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    toImport.push(c);
  }

  // Show what will be skipped
  const skippedOrgs = [...new Set(
    clients.filter(c => c._org && orgCounts[c._org] > 1).map(c => c._org)
  )];
  if (skippedOrgs.length) {
    console.log(`\nSkipping ${skippedOrgs.length} orgs with multiple rows:`);
    skippedOrgs.forEach(o => console.log(`  - ${o}`));
  }

  // Import
  console.log(`\nImporting ${toImport.length} clients:\n`);
  let imported = 0;
  for (const c of toImport) {
    await pool.query(`
      INSERT INTO clients (
        name, contact_person, email,
        address_line1, address_line2, city, postal_code,
        country_code, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      c.name, c.contact_person, c.email,
      c.address_line1, c.address_line2, c.city, c.postal_code,
      c.country_code, c.notes,
    ]);
    console.log(`  + ${c.name}`);
    imported++;
  }

  console.log(`\nDone. ${imported} clients imported.`);
  await pool.end();
}

const csvPath = process.argv[2] || path.join(__dirname, '..', 'clients.csv');
importClients(csvPath).catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
