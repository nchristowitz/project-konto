const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const DIR = path.join(__dirname, '..', 'data', 'freshbooks-imports');
const FILES = [
  'Invoice 2200009.pdf',
  'Invoice 2200010.pdf',
  'Invoice 2300007.pdf',
  'Invoice 250010.pdf',
];

async function main() {
  for (const file of FILES) {
    const filePath = path.join(DIR, file);
    const buf = fs.readFileSync(filePath);
    const uint8 = new Uint8Array(buf);
    const pdf = new PDFParse(uint8);
    const result = await pdf.getText();
    const text = result.text;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`FILE: ${file}`);
    console.log(`${'='.repeat(60)}`);

    // Show raw text around "Date of Issue"
    const idx = text.indexOf('Date of Issue');
    if (idx === -1) {
      console.log('  "Date of Issue" NOT FOUND in extracted text');
      // Show first 500 chars to see what's there
      console.log('  First 500 chars of text:');
      console.log(text.slice(0, 500));
    } else {
      const start = Math.max(0, idx - 100);
      const end = Math.min(text.length, idx + 200);
      const snippet = text.slice(start, end);
      console.log('  Context around "Date of Issue":');
      // Show the snippet with visible whitespace
      const visible = snippet
        .replace(/\t/g, '→TAB→')
        .replace(/ /g, '·');
      console.log(visible);
    }

    // Also show around "Due Date"
    const idx2 = text.indexOf('Due Date');
    if (idx2 !== -1) {
      const start2 = Math.max(0, idx2 - 50);
      const end2 = Math.min(text.length, idx2 + 150);
      const snippet2 = text.slice(start2, end2);
      console.log('\n  Context around "Due Date":');
      const visible2 = snippet2
        .replace(/\t/g, '→TAB→')
        .replace(/ /g, '·');
      console.log(visible2);
    }

    // Try to find any date-like patterns in the text
    const datePatterns = text.match(/\d{1,4}[\.\-\/]\d{1,2}[\.\-\/]\d{1,4}/g);
    console.log('\n  All date-like patterns found:', datePatterns);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
