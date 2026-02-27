// Dynamic line items and total calculation for invoice form

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

// Client selector: auto-fill currency, VAT, and due date
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
    if (display) display.textContent = lineTotal.toFixed(2);
    subtotal += lineTotal;
  });

  const vatRate = parseFloat(vatRateInput?.value) || 0;
  const isRC = rcCheckbox?.checked;
  const vatAmount = isRC ? 0 : Math.round(subtotal * vatRate / 100 * 100) / 100;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;

  const vatLabel = document.getElementById('vat_label')?.value || 'VAT';

  document.getElementById('subtotal').textContent = subtotal.toFixed(2);
  document.getElementById('vat-label').textContent = `${vatLabel} ${vatRate}%`;
  document.getElementById('vat-total').textContent = vatAmount.toFixed(2);
  document.getElementById('grand-total').textContent = total.toFixed(2);
}

// Initial calculation
recalculate();
