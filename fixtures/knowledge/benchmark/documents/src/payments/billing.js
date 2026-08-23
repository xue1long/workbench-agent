// Billing: invoice generation and payment records.
// Payments are recorded as immutable ledger entries; invoices are derived
// projections over the ledger for the workspace billing cycle.
export function buildInvoice(ledger, { cycleStart, cycleEnd }) {
  const entries = ledger.filter((e) => e.at >= cycleStart && e.at < cycleEnd);
  const subtotal = entries.reduce((acc, e) => acc + e.amountUsd, 0);
  return { cycleStart, cycleEnd, entries: entries.length, subtotalUsd: subtotal };
}

export function recordPayment(ledger, { amountUsd, method, at }) {
  ledger.push({ id: `pay-${ledger.length + 1}`, amountUsd, method, at });
  return ledger[ledger.length - 1];
}
