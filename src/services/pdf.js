const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const LINE_HEIGHT = 14;
const FONT_SIZE = 9;
const TITLE_SIZE = 16;
const HEADING_SIZE = 11;

const UNIT_LABELS = {
  HUR: 'hrs',
  DAY: 'days',
  MON: 'months',
  EA: 'ea',
  C62: 'units',
};

function unitLabel(code) {
  return UNIT_LABELS[code] || code.toLowerCase();
}

function fmt(value) {
  return Number(value).toFixed(2);
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

async function generateInvoicePdf({ invoice, lines, profile, client, documentTitle = 'INVOICE', dueDateLabel = 'Due:', statusWatermark = null }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const fontBold = await doc.embedFont(StandardFonts.CourierBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function checkPage(needed) {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  }

  function drawText(text, x, size, useBold) {
    const f = useBold ? fontBold : font;
    checkPage(size + 2);
    page.drawText(text, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  }

  function drawTextRight(text, size, useBold) {
    const f = useBold ? fontBold : font;
    const w = f.widthOfTextAtSize(text, size);
    checkPage(size + 2);
    page.drawText(text, { x: PAGE_WIDTH - MARGIN - w, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  }

  function drawLine() {
    checkPage(4);
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    y -= LINE_HEIGHT;
  }

  // Wrap text into lines that fit within maxWidth
  function wrapText(text, maxWidth, size, f) {
    const words = text.split(/\s+/);
    const result = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) result.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) result.push(current);
    return result;
  }

  // --- Seller header ---
  if (profile.name) {
    drawText(profile.name, MARGIN, HEADING_SIZE, true);
    y -= LINE_HEIGHT;
  }
  const addressParts = [];
  if (profile.address_line1) addressParts.push(profile.address_line1);
  if (profile.address_line2) addressParts.push(profile.address_line2);
  const cityLine = [profile.postal_code, profile.city].filter(Boolean).join(' ');
  if (cityLine) {
    addressParts.push(cityLine + (profile.country_code ? `, ${profile.country_code}` : ''));
  }
  if (profile.vat_number) addressParts.push(`VAT: ${profile.vat_number}`);
  if (profile.email) addressParts.push(profile.email);

  for (const line of addressParts) {
    drawText(line, MARGIN, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }

  y -= LINE_HEIGHT;

  // --- Invoice title ---
  drawText(`${documentTitle} ${invoice.number}`, MARGIN, TITLE_SIZE, true);
  y -= LINE_HEIGHT * 2;

  // --- Bill-to (left) + Dates (right) ---
  const billToX = MARGIN;
  const datesX = MARGIN + CONTENT_WIDTH * 0.6;
  const savedY = y;

  // Bill-to
  drawText('Bill to:', billToX, FONT_SIZE, true);
  y -= LINE_HEIGHT;
  if (client.name) {
    drawText(client.name, billToX, FONT_SIZE, true);
    y -= LINE_HEIGHT;
  }
  if (client.contact_person) {
    drawText(client.contact_person, billToX, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }
  if (client.address_line1) {
    drawText(client.address_line1, billToX, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }
  if (client.address_line2) {
    drawText(client.address_line2, billToX, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }
  const clientCity = [client.postal_code, client.city].filter(Boolean).join(' ');
  if (clientCity) {
    drawText(clientCity + (client.country_code ? `, ${client.country_code}` : ''), billToX, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }
  if (client.vat_number) {
    drawText(`VAT: ${client.vat_number}`, billToX, FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }

  const billToEndY = y;

  // Dates (right column)
  y = savedY;
  drawText('Date:', datesX, FONT_SIZE, true);
  drawTextRight(formatDate(invoice.issue_date), FONT_SIZE, false);
  y -= LINE_HEIGHT;
  if (invoice.due_date) {
    drawText(dueDateLabel, datesX, FONT_SIZE, true);
    drawTextRight(formatDate(invoice.due_date), FONT_SIZE, false);
    y -= LINE_HEIGHT;
  }

  y = Math.min(y, billToEndY);
  y -= LINE_HEIGHT;

  // --- Separator ---
  drawLine();

  // --- Line items header ---
  const colDesc = MARGIN;
  const colQty = MARGIN + CONTENT_WIDTH * 0.6;
  const colAmount = PAGE_WIDTH - MARGIN;

  drawText('Description', colDesc, FONT_SIZE, true);
  drawText('Qty', colQty, FONT_SIZE, true);
  drawTextRight('Amount', FONT_SIZE, true);
  y -= LINE_HEIGHT;
  y -= 4;

  // --- Line items ---
  for (const line of lines) {
    checkPage(LINE_HEIGHT * 2);

    // Description (with wrapping)
    const descMaxWidth = CONTENT_WIDTH * 0.55;
    const descLines = wrapText(line.description, descMaxWidth, FONT_SIZE, font);
    const firstDescLine = descLines[0] || '';

    drawText(firstDescLine, colDesc, FONT_SIZE, false);

    // Qty
    const qtyText = `${Number(line.quantity)} ${unitLabel(line.unit_code)}`;
    drawText(qtyText, colQty, FONT_SIZE, false);

    // Amount (right-aligned)
    drawTextRight(fmt(line.line_total), FONT_SIZE, false);
    y -= LINE_HEIGHT;

    // Additional description lines
    for (let i = 1; i < descLines.length; i++) {
      checkPage(LINE_HEIGHT);
      drawText(descLines[i], colDesc, FONT_SIZE, false);
      y -= LINE_HEIGHT;
    }

    // Detail line
    if (line.detail) {
      const detailLines = wrapText(line.detail, descMaxWidth, FONT_SIZE - 1, font);
      for (const dl of detailLines) {
        checkPage(LINE_HEIGHT);
        page.drawText(dl, { x: colDesc + 10, y, size: FONT_SIZE - 1, font, color: rgb(0.4, 0.4, 0.4) });
        y -= LINE_HEIGHT;
      }
    }

    y -= 2;
  }

  // --- Separator ---
  y -= 4;
  drawLine();

  // --- Totals ---
  const totalsLabelX = MARGIN + CONTENT_WIDTH * 0.55;

  checkPage(LINE_HEIGHT * 5);
  drawText('Subtotal', totalsLabelX, FONT_SIZE, false);
  drawTextRight(fmt(invoice.subtotal), FONT_SIZE, false);
  y -= LINE_HEIGHT;

  const vatLabel = `${invoice.vat_label || 'VAT'} ${Number(invoice.vat_rate)}%`;
  drawText(vatLabel, totalsLabelX, FONT_SIZE, false);
  drawTextRight(fmt(invoice.vat_amount), FONT_SIZE, false);
  y -= LINE_HEIGHT;

  if (invoice.vat_note) {
    const noteLines = wrapText(invoice.vat_note, CONTENT_WIDTH * 0.4, FONT_SIZE - 1, font);
    for (const nl of noteLines) {
      checkPage(LINE_HEIGHT);
      page.drawText(nl, { x: totalsLabelX, y, size: FONT_SIZE - 1, font, color: rgb(0.4, 0.4, 0.4) });
      y -= LINE_HEIGHT;
    }
  }

  // Short separator above total
  page.drawLine({
    start: { x: totalsLabelX, y: y + 4 },
    end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 4;

  drawText('Total', totalsLabelX, HEADING_SIZE, true);
  drawTextRight(`${fmt(invoice.total)} ${invoice.currency}`, HEADING_SIZE, true);
  y -= LINE_HEIGHT + 4;

  // Paid / Balance
  if (Number(invoice.amount_paid) > 0) {
    drawText('Paid', totalsLabelX, FONT_SIZE, false);
    drawTextRight(fmt(invoice.amount_paid), FONT_SIZE, false);
    y -= LINE_HEIGHT;

    const balance = (Number(invoice.total) - Number(invoice.amount_paid)).toFixed(2);
    drawText('Balance', totalsLabelX, HEADING_SIZE, true);
    drawTextRight(`${balance} ${invoice.currency}`, HEADING_SIZE, true);
    y -= LINE_HEIGHT + 4;
  }

  y -= LINE_HEIGHT;

  // --- Payment details ---
  if (invoice.payment_details) {
    checkPage(LINE_HEIGHT * 3);
    drawText('Payment details:', MARGIN, FONT_SIZE, true);
    y -= LINE_HEIGHT;

    const paymentLines = invoice.payment_details.split('\n');
    for (const pl of paymentLines) {
      checkPage(LINE_HEIGHT);
      drawText(pl, MARGIN, FONT_SIZE, false);
      y -= LINE_HEIGHT;
    }
    y -= LINE_HEIGHT;
  }

  // --- Notes ---
  if (invoice.notes) {
    checkPage(LINE_HEIGHT * 2);
    const noteLines = wrapText(invoice.notes, CONTENT_WIDTH, FONT_SIZE, font);
    for (const nl of noteLines) {
      checkPage(LINE_HEIGHT);
      drawText(nl, MARGIN, FONT_SIZE, false);
      y -= LINE_HEIGHT;
    }
    y -= LINE_HEIGHT;
  }

  // --- Footer ---
  if (invoice.footer_text) {
    checkPage(LINE_HEIGHT * 2);
    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: PAGE_WIDTH - MARGIN, y: y + 4 },
      thickness: 0.3,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 4;
    const footerLines = wrapText(invoice.footer_text, CONTENT_WIDTH, FONT_SIZE - 1, font);
    for (const fl of footerLines) {
      checkPage(LINE_HEIGHT);
      page.drawText(fl, { x: MARGIN, y, size: FONT_SIZE - 1, font, color: rgb(0.4, 0.4, 0.4) });
      y -= LINE_HEIGHT;
    }
  }

  // Draw status watermark on all pages
  if (statusWatermark) {
    const wmFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const wmSize = 60;
    const wmText = statusWatermark.toUpperCase();
    const wmWidth = wmFont.widthOfTextAtSize(wmText, wmSize);
    const wmColor = statusWatermark === 'PAID'
      ? rgb(0.0, 0.6, 0.2)
      : rgb(0.8, 0.0, 0.0);

    const pages = doc.getPages();
    for (const p of pages) {
      const { width, height } = p.getSize();
      p.drawText(wmText, {
        x: (width - wmWidth * Math.cos(35 * Math.PI / 180)) / 2,
        y: height / 2,
        size: wmSize,
        font: wmFont,
        color: wmColor,
        opacity: 0.15,
        rotate: degrees(-35),
      });
    }
  }

  return doc.save();
}

module.exports = { generateInvoicePdf };
