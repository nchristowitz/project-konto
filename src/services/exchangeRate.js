// ECB exchange rates via frankfurter.app (free, no API key)
// Rates are EUR-based, updated daily around 16:00 CET

let cache = { rates: null, date: null, fetchedAt: 0 };
const CACHE_TTL = 3600000; // 1 hour

async function getRates() {
  if (cache.rates && Date.now() - cache.fetchedAt < CACHE_TTL) {
    return cache;
  }

  const res = await fetch('https://api.frankfurter.dev/v1/latest');
  if (!res.ok) throw new Error(`Exchange rate fetch failed: ${res.status}`);

  const data = await res.json();
  cache = { rates: { EUR: 1, ...data.rates }, date: data.date, fetchedAt: Date.now() };
  return cache;
}

async function convertToEUR(amounts) {
  const { rates, date } = await getRates();
  let totalEUR = 0;

  for (const { currency, amount } of amounts) {
    const rate = rates[currency];
    if (!rate) continue;
    totalEUR += Number(amount) / rate;
  }

  return { totalEUR, date };
}

module.exports = { getRates, convertToEUR };
