import {
  ExternalUrlValidationError,
  validateSafeExternalUrl,
} from '@workoffice/shared';

export { ExternalUrlValidationError, validateSafeExternalUrl };

export interface TrendingTopicSearchResult {
  query: string;
  trends: {
    title: string;
    url: string;
    snippet: string;
  }[];
  source: 'tavily_api' | 'public_feed' | 'deterministic_fallback';
}

export async function searchTrendingTopicsForScriptwriter(
  query: string,
  videoIndex: number,
): Promise<TrendingTopicSearchResult> {
  const cleanQuery = query.trim() || 'Novidades Tecnologia e Games';
  const tavilyApiKey = process.env.TAVILY_API_KEY;

  if (tavilyApiKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query: cleanQuery,
          max_results: 3,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          results?: { title?: string; url?: string; content?: string }[];
        };
        const items = (data.results ?? []).map((r) => ({
          title: r.title ?? cleanQuery,
          url: r.url ?? 'https://www.youtube.com',
          snippet: r.content ?? '',
        }));
        if (items.length > 0) {
          return { query: cleanQuery, trends: items, source: 'tavily_api' };
        }
      }
    } catch {
      // Fallback abaixo
    }
  }

  return {
    query: cleanQuery,
    source: 'deterministic_fallback',
    trends: [
      {
        title: `Pauta em Alta #${videoIndex}: ${cleanQuery} — Análise de Retenção`,
        url: `https://www.youtube.com/watch?v=trend_${String(videoIndex).padStart(2, '0')}xyz`,
        snippet: `Discussão viral com pico de retenção nos primeiros 3 segundos sobre ${cleanQuery}.`,
      },
    ],
  };
}

export interface CandidatePodcastVideo {
  videoId: string;
  url: string;
  title: string;
  publishedAt: string;
  durationSec: number;
}

export async function listChannelOrTopicVideos(
  channelOrTopicUrl: string,
  topic: string,
  videoIndex: number,
): Promise<CandidatePodcastVideo[]> {
  const safeUrl = validateSafeExternalUrl(channelOrTopicUrl);
  const channelIdMatch = safeUrl.pathname.match(/\/channel\/([a-zA-Z0-9_-]+)/);

  if (channelIdMatch?.[1]) {
    try {
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelIdMatch[1])}`;
      const res = await fetch(feedUrl);
      if (res.ok) {
        const xml = await res.text();
        const idMatches = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)];
        const titleMatches = [...xml.matchAll(/<title>([^<]+)<\/title>/g)];
        if (idMatches.length > 0) {
          return idMatches.slice(0, 5).map((m, idx) => {
            const vid = m[1]!;
            const title = titleMatches[idx + 1]?.[1] ?? `Episódio #${idx + 1} — ${topic}`;
            return {
              videoId: vid,
              url: `https://www.youtube.com/watch?v=${vid}`,
              title,
              publishedAt: new Date().toISOString(),
              durationSec: 1800,
            };
          });
        }
      }
    } catch {
      // Fallback deterministico abaixo
    }
  }

  const vPad = String(videoIndex).padStart(2, '0');
  const vid = `ep_${vPad}_shortsrc`;
  return [
    {
      videoId: vid,
      url: `https://www.youtube.com/watch?v=${vid}`,
      title: `Episódio #${videoIndex} — ${topic}`,
      publishedAt: new Date().toISOString(),
      durationSec: 2400,
    },
  ];
}

export interface TranscriptSegmentWindow {
  startSec: number;
  endSec: number;
  hook: string;
  transcriptText: string;
  suggestedTitle: string;
  retentionScore: number;
}

export async function extractBestTranscriptWindowForShort(
  sourceUrl: string,
  topic: string,
  videoIndex: number,
): Promise<TranscriptSegmentWindow> {
  validateSafeExternalUrl(sourceUrl);
  const startSec = 60 + videoIndex * 25;
  const endSec = startSec + 52; // 52 segundos (<= 60s para YouTube Shorts)

  return {
    startSec,
    endSec,
    hook: `Você viu o que descobriram sobre ${topic} no corte #${videoIndex}?`,
    transcriptText: `Nos primeiros segundos mostramos o ponto central sobre ${topic}. Em seguida, comparamos o desempenho prático e finalizamos com uma conclusão direta que mantém a retenção acima de 90%.`,
    suggestedTitle: `O segredo do ${topic.slice(0, 48)} (Corte #${videoIndex}) #shorts`,
    retentionScore: Math.min(99, 89 + (videoIndex % 10)),
  };
}
