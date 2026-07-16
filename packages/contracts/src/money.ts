export const toUsd = (amountUzs: string, rate: string): string => {
  const amount = Number(amountUzs);
  const exchangeRate = Number(rate);
  if (!Number.isFinite(amount) || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return '0.00';
  return (amount / exchangeRate).toFixed(2);
};
