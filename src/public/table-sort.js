(function () {
  var statusOrder = {
    draft: 0, sent: 1, viewed: 2, partially_paid: 3, overdue: 4, paid: 5, cancelled: 6,
    accepted: 3, rejected: 4, expired: 5, converted: 6
  };

  function compare(a, b, type) {
    if (type === 'number') {
      return (parseFloat(a) || 0) - (parseFloat(b) || 0);
    }
    if (type === 'date') {
      return (a || '').localeCompare(b || '');
    }
    if (type === 'status') {
      return (statusOrder[a] ?? 99) - (statusOrder[b] ?? 99);
    }
    return (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
  }

  function init() {
    var headers = document.querySelectorAll('th[data-sort]');
    headers.forEach(function (th) {
      th.addEventListener('click', function () {
        var table = th.closest('table');
        var tbody = table.querySelector('tbody');
        if (!tbody) return;

        var idx = Array.from(th.parentNode.children).indexOf(th);
        var type = th.getAttribute('data-sort');
        var asc = !th.classList.contains('sort-asc');

        // Clear other sort indicators in this table
        table.querySelectorAll('th[data-sort]').forEach(function (h) {
          h.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');

        var rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort(function (ra, rb) {
          var ca = ra.children[idx];
          var cb = rb.children[idx];
          var va = ca ? (ca.getAttribute('data-value') || ca.textContent.trim()) : '';
          var vb = cb ? (cb.getAttribute('data-value') || cb.textContent.trim()) : '';
          var result = compare(va, vb, type);
          return asc ? result : -result;
        });

        rows.forEach(function (row) {
          tbody.appendChild(row);
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
