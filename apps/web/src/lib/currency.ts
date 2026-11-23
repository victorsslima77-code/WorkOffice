export type DisplayCurrency = 'USD' | 'BRL';

export interface ExchangeRateState {
  rate: number;
  source: 'brasilapi' | 'awesomeapi' | 'open_er_api' | 'fallback';
  referenceDate: string;
}

export const DEFAULT_USD_TO_BRL_RATE = 5.75;

/**
 * Formata um valor originalmente em USD para USD ($0.0035) ou BRL (R$ 0,0201)
 * usando a cotacao do dia.
 */
export function formatMoneyFromUsd(
  usdValue: number,
  currency: DisplayCurrency,
  usdToBrlRate: number,
  options?: { decimals?: number; includeCode?: boolean },
): string {
  const safeUsd = Number.isFinite(usdValue) ? usdValue : 0;
  const decimals = options?.decimals ?? 4;
  const includeCode = options?.includeCode ?? false;

  if (currency === 'BRL') {
    const safeRate =
      Number.isFinite(usdToBrlRate) && usdToBrlRate > 0
        ? usdToBrlRate
        : DEFAULT_USD_TO_BRL_RATE;
    const brlValue = safeUsd * safeRate;
    const formatted = brlValue.toLocaleString('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return includeCode ? `R$ ${formatted} BRL` : `R$ ${formatted}`;
  }

  const formatted = safeUsd.toFixed(decimals);
  return includeCode ? `$${formatted} USD` : `$${formatted}`;
}
