// Dynamic line items and total calculation for invoice form

function fmtNum(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const lineItemsContainer = document.getElementById('line-items');
const addLineBtn = document.getElementById('add-line');

const lineTemplate = `
<div class="line-item">
  <div class="line-item-fields">
    <div class="form-group line-desc">
      <input type="text" name="descriptions" placeholder="Description" required>
    </div>
    <div class="form-group line-qty">
      <input type="number" name="quantities" step="0.001" value="1" class="qty-input">
    </div>
    <div class="form-group line-unit">
      <select name="unit_codes">
        <option value="HUR">hr</option>
        <option value="DAY">day</option>
        <option value="EA">ea</option>
        <option value="MON">mo</option>
        <option value="C62">unit</option>
      </select>
    </div>
    <div class="form-group line-price">
      <input type="number" name="unit_prices" step="0.01" placeholder="0.00" class="price-input">
    </div>
    <div class="form-group line-total-display">
      <span class="line-total-value">0.00</span>
    </div>
    <button type="button" class="remove-line" title="Remove">&times;</button>
  </div>
  <div class="form-group line-detail">
    <textarea name="details" rows="2" placeholder="Detail (optional)"></textarea>
  </div>
</div>`;

if (addLineBtn) {
  addLineBtn.addEventListener('click', () => {
    lineItemsContainer.insertAdjacentHTML('beforeend', lineTemplate);
    recalculate();
  });
}

lineItemsContainer.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-line')) {
    const items = lineItemsContainer.querySelectorAll('.line-item');
    if (items.length > 1) {
      e.target.closest('.line-item').remove();
      recalculate();
    }
  }
});

lineItemsContainer.addEventListener('input', recalculate);

// Reverse charge checkbox
const rcCheckbox = document.getElementById('reverse_charge');
if (rcCheckbox) {
  rcCheckbox.addEventListener('change', recalculate);
}

// VAT rate input
const vatRateInput = document.getElementById('vat_rate');
if (vatRateInput) {
  vatRateInput.addEventListener('input', recalculate);
}

// Bank account selector
const bankAccountSelect = document.getElementById('bank_account_id');
const paymentDetailsTextarea = document.getElementById('payment_details');

function populatePaymentDetails() {
  if (!bankAccountSelect || !paymentDetailsTextarea) return;
  const opt = bankAccountSelect.options[bankAccountSelect.selectedIndex];
  if (!opt || !opt.value) return;

  const lines = [];
  const holder = opt.dataset.accountHolder;
  const bank = opt.dataset.bankName;
  const iban = opt.dataset.iban;
  const bic = opt.dataset.bic;
  const accountNumber = opt.dataset.accountNumber;
  const routingNumber = opt.dataset.routingNumber;
  const swiftCode = opt.dataset.swiftCode;
  if (holder) lines.push('Account holder: ' + holder);
  if (bank) lines.push('Bank: ' + bank);
  if (iban) lines.push('IBAN: ' + iban);
  if (bic) lines.push('BIC: ' + bic);
  if (accountNumber) lines.push('Account: ' + accountNumber);
  if (routingNumber) lines.push('Routing: ' + routingNumber);
  if (swiftCode) lines.push('SWIFT: ' + swiftCode);
  paymentDetailsTextarea.value = lines.join('\n');
}

if (bankAccountSelect) {
  bankAccountSelect.addEventListener('change', populatePaymentDetails);
}

// Client selector: auto-fill currency, VAT, due date, and bank account
const clientSelect = document.getElementById('client_id');
if (clientSelect) {
  clientSelect.addEventListener('change', () => {
    const opt = clientSelect.options[clientSelect.selectedIndex];
    if (opt && opt.value) {
      document.getElementById('currency').value = opt.dataset.currency || 'EUR';
      document.getElementById('vat_rate').value = opt.dataset.vat || '19.00';

      // Calculate due date from payment terms
      const terms = parseInt(opt.dataset.terms, 10) || 30;
      const issueDate = new Date(document.getElementById('issue_date').value || Date.now());
      const dueDate = new Date(issueDate);
      dueDate.setDate(dueDate.getDate() + terms);
      document.getElementById('due_date').value = dueDate.toISOString().slice(0, 10);

      // Set bank account from client default
      if (bankAccountSelect) {
        const clientBankId = opt.dataset.bankAccount;
        if (clientBankId) {
          bankAccountSelect.value = clientBankId;
        } else {
          // Fall back to system default (first option with is_default, or first non-empty)
          const defaultOpt = bankAccountSelect.querySelector('option[value]:not([value=""])');
          if (defaultOpt) bankAccountSelect.value = defaultOpt.value;
        }
        populatePaymentDetails();
      }

      recalculate();
    }
  });
}

function recalculate() {
  const items = lineItemsContainer.querySelectorAll('.line-item');
  let subtotal = 0;

  items.forEach(item => {
    const qty = parseFloat(item.querySelector('.qty-input')?.value) || 0;
    const price = parseFloat(item.querySelector('.price-input')?.value) || 0;
    const lineTotal = Math.round(qty * price * 100) / 100;
    const display = item.querySelector('.line-total-value');
    if (display) display.textContent = fmtNum(lineTotal);
    subtotal += lineTotal;
  });

  const vatRate = parseFloat(vatRateInput?.value) || 0;
  const isRC = rcCheckbox?.checked;
  const vatAmount = isRC ? 0 : Math.round(subtotal * vatRate / 100 * 100) / 100;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;

  const vatLabel = document.getElementById('vat_label')?.value || 'VAT';

  document.getElementById('subtotal').textContent = fmtNum(subtotal);
  document.getElementById('vat-label').textContent = `${vatLabel} ${vatRate}%`;
  document.getElementById('vat-total').textContent = fmtNum(vatAmount);
  document.getElementById('grand-total').textContent = fmtNum(total);
}

// Initial calculation
recalculate();
