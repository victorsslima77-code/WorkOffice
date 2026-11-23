import { NextResponse } from 'next/server';

interface BrasilApiCotacaoItem {
  cotacao_compra?: number;
  cotacao_venda?: number;
  data_hora_cotacao?: string;
  tipo_boletim?: string;
}

interface BrasilApiCambioResponse {
  moeda?: string;
  data?: string;
  cotacoes?: BrasilApiCotacaoItem[];
}

function formatDateYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function fetchFromBrasilApi(): Promise<{
  rate: number;
  referenceDate: string;
} | null> {
  // Tenta hoje e retrocede ate 5 dias (caso hoje seja fim de semana, feriado ou antes da abertura PTAX)
  const now = new Date();
  for (let offsetDays = 0; offsetDays <= 5; offsetDays++) {
    const candidateDate = new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000);
    const ymd = formatDateYmd(candidateDate);

    try {
      const res = await fetch(`https://brasilapi.com.br/api/cambio/v1/cotacao/USD/${ymd}`, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 1800 },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as BrasilApiCambioResponse;
      const list = json.cotacoes ?? [];
      const latest = list[list.length - 1];
      const rate = Number(latest?.cotacao_venda ?? latest?.cotacao_compra ?? 0);
      if (Number.isFinite(rate) && rate > 1) {
        return {
          rate: Number(rate.toFixed(4)),
          referenceDate: json.data ?? ymd,
        };
      }
    } catch {
      // Tenta proximo dia util ou fallback abaixo
    }
  }
  return null;
}

async function fetchFromAwesomeApi(): Promise<{
  rate: number;
  referenceDate: string;
} | null> {
  try {
    const res = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 1800 },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      USDBRL?: { bid?: string; ask?: string; create_date?: string };
    };
    const rate = Number(json.USDBRL?.ask ?? json.USDBRL?.bid ?? 0);
    if (Number.isFinite(rate) && rate > 1) {
      return {
        rate: Number(rate.toFixed(4)),
        referenceDate: json.USDBRL?.create_date?.slice(0, 10) ?? formatDateYmd(new Date()),
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchFromOpenErApi(): Promise<{
  rate: number;
  referenceDate: string;
} | null> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 1800 },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { rates?: { BRL?: number } };
    const rate = Number(json.rates?.BRL ?? 0);
    if (Number.isFinite(rate) && rate > 1) {
      return {
        rate: Number(rate.toFixed(4)),
        referenceDate: formatDateYmd(new Date()),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function GET() {
  const brasil = await fetchFromBrasilApi();
  if (brasil) {
    return NextResponse.json({
      rate: brasil.rate,
      source: 'brasilapi',
      referenceDate: brasil.referenceDate,
    });
  }

  const awesome = await fetchFromAwesomeApi();
  if (awesome) {
    return NextResponse.json({
      rate: awesome.rate,
      source: 'awesomeapi',
      referenceDate: awesome.referenceDate,
    });
  }

  const openEr = await fetchFromOpenErApi();
  if (openEr) {
    return NextResponse.json({
      rate: openEr.rate,
      source: 'open_er_api',
      referenceDate: openEr.referenceDate,
    });
  }

  return NextResponse.json({
    rate: 5.75,
    source: 'fallback',
    referenceDate: formatDateYmd(new Date()),
  });
}
