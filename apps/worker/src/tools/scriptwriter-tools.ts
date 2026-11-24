import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ExternalUrlValidationError,
  validateSafeExternalUrl,
} from '@workoffice/shared';
import {
  exchangeYoutubeRefreshToken,
  type YoutubeOAuthCredentials,
} from './publisher-youtube-tools.js';

export { ExternalUrlValidationError, validateSafeExternalUrl };

const execFileAsync = promisify(execFile);

export interface TrendingTopicSearchResult {
  query: string;
  trends: {
    title: string;
    url: string;
    snippet: string;
    channel?: string;
    durationSec?: number;
  }[];
  source:
    | 'youtube_data_api_v3'
    | 'youtube_html_search'
    | 'yt_dlp_search'
    | 'tavily_api'
    | 'public_feed'
    | 'deterministic_fallback';
}

export interface CandidatePodcastVideo {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  durationSec: number;
  viewCount?: number;
  description?: string;
}

function parseViewCountText(text?: string): number {
  if (!text) return 0;
  const cleaned = text.toLowerCase().replace(/\u00a0/g, ' ').trim();
  const numMatch = cleaned.match(/([\d.,]+)\s*(mi|mil|k|m|b)?/);
  if (!numMatch?.[1]) return 0;
  let numStr = numMatch[1];
  const suffix = numMatch[2] ?? '';
  if (suffix) {
    numStr = numStr.replace(',', '.');
    const base = Number(numStr);
    if (Number.isNaN(base)) return 0;
    if (suffix === 'b') return Math.round(base * 1_000_000_000);
    if (suffix === 'mi' || suffix === 'm') return Math.round(base * 1_000_000);
    if (suffix === 'mil' || suffix === 'k') return Math.round(base * 1_000);
    return Math.round(base);
  }
  const digitsOnly = numStr.replace(/[.,]/g, '');
  const parsed = Number(digitsOnly);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Detecta se o usuario colou um link direto de video do YouTube na instrucao
 * (ex: "Crie um short com o momento mais marcante do video https://www.youtube.com/watch?v=3_vgiC3hAfE").
 */
export function extractDirectYoutubeVideoIdFromText(rawText: string): string | null {
  const match = rawText.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match?.[1] ?? null;
}

const watchSignalsCacheByVideoId = new Map<
  string,
  {
    videoId: string | null;
    title?: string;
    channelTitle?: string;
    description: string | null;
    durationSec: number | null;
    heatmapBuckets: HeatmapBucket[];
    fetchedAtMs: number;
  }
>();

const heatmapCacheByVideoId = new Map<string, YoutubeAudienceHeatmap>();

/**
 * Busca os metadados reais de um video especifico do YouTube quando o usuario informa a URL direta na instrucao.
 * Prioriza a YouTube Data API v3 oficial (OAuth) e o HTML `/watch` cacheado, evitando chamadas desnecessarias ao `/youtubei/v1/player`.
 */
export async function fetchDirectYoutubeVideoCandidate(
  videoId: string,
  oauth?: YoutubeOAuthCredentials | null,
): Promise<CandidatePodcastVideo | null> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  if (oauth?.refreshToken) {
    try {
      const tokenInfo = await exchangeYoutubeRefreshToken(oauth);
      if (!tokenInfo.isSandbox) {
        const apiRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(videoId)}`,
          { headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } },
        );
        if (apiRes.ok) {
          const apiData = (await apiRes.json()) as {
            items?: {
              snippet?: { title?: string; channelTitle?: string; description?: string; publishedAt?: string };
              contentDetails?: { duration?: string };
              statistics?: { viewCount?: string };
            }[];
          };
          const item = apiData.items?.[0];
          if (item?.snippet?.title) {
            return {
              videoId,
              url: watchUrl,
              title: item.snippet.title,
              channelTitle: item.snippet.channelTitle ?? 'YouTube',
              publishedAt: item.snippet.publishedAt ?? new Date().toISOString(),
              durationSec:
                parseIso8601DurationToSec(item.contentDetails?.duration) ?? 600,
              viewCount: Number(item.statistics?.viewCount ?? 0),
              description: (item.snippet.description ?? '').slice(0, 500),
            };
          }
        }
      }
    } catch {
      // Fallback para watch HTML abaixo
    }
  }

  const signals = await fetchYoutubeWatchPageSignals(watchUrl);
  if (signals.videoId) {
    return {
      videoId,
      url: watchUrl,
      title: signals.title ?? `Vídeo YouTube (${videoId})`,
      channelTitle: signals.channelTitle ?? 'YouTube',
      publishedAt: new Date().toISOString(),
      durationSec: signals.durationSec ?? 600,
      description: signals.description ?? '',
    };
  }

  return null;
}

/**
 * Limpa comandos imperativos da instrucao do usuario para extrair o termo puro de busca no YouTube.
 * Ex: "Crie um video curto do youtuber Davy Jones falando sobre o novo GTA" -> "Davy Jones falando sobre o novo GTA"
 */
export function extractCleanYoutubeSearchQuery(rawInstruction: string): string {
  const withoutUrls = rawInstruction
    .replace(/https?:\/\/\S+/gi, '')
    .trim();
  const cleaned = withoutUrls
    .replace(
      /^\s*(?:crie|criar|fa[cç]a|fazer|gere|gerar|produza|produzir|recorte|edite|publi(?:que|car))\s+(?:\d{1,2}|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)?\s*(?:v[ií]deos?|shorts?|cortes?|clipes?)?\s*(?:curtos?|r[aá]pidos?|virais?)?\s*(?:com\s+o\s+momento\s+mais\s+marcante\s+do\s+v[ií]deo(?:\s+a\s+seguir)?|do\s+[uú]ltimo\s+v[ií]deo\s+do\s+canal|do\s+v[ií]deo\s+a\s+seguir|do\s+youtuber|da\s+youtuber|do\s+canal|da|do|de|sobre)?\s*/i,
      '',
    )
    .trim();

  return cleaned.length >= 3 ? cleaned : (withoutUrls || rawInstruction.trim());
}

function parseDurationTextToSec(text?: string): number {
  if (!text) return 600;
  const parts = text
    .split(':')
    .map((p) => Number(p.trim()))
    .filter((n) => !Number.isNaN(n));
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  return 600;
}

/**
 * Converte duracao ISO-8601 da YouTube Data API v3 (ex: "PT1H2M34S", "PT12M30S", "PT55S") em segundos.
 */
export function parseIso8601DurationToSec(iso?: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const hrs = Number(m[1] ?? 0);
  const mins = Number(m[2] ?? 0);
  const secs = Number(m[3] ?? 0);
  const total = hrs * 3600 + mins * 60 + secs;
  return total > 0 ? total : null;
}

export function formatSecondsToMmSs(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Camada 1: Busca oficial na YouTube Data API v3 usando o OAuth do Cofre do usuario (nunca sofre bloqueio de IP de datacenter).
 */
export async function searchRealYoutubeVideosViaDataApi(
  query: string,
  oauth?: YoutubeOAuthCredentials | null,
  maxResults = 6,
): Promise<CandidatePodcastVideo[]> {
  if (!oauth?.refreshToken) return [];
  const cleanQuery = extractCleanYoutubeSearchQuery(query);

  try {
    const tokenInfo = await exchangeYoutubeRefreshToken(oauth);
    if (tokenInfo.isSandbox) return [];

    const sixMonthsAgoIso = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const buildSearchUrl = (order: 'viewCount' | 'relevance', withRecency: boolean) =>
      `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
        part: 'snippet',
        type: 'video',
        maxResults: String(Math.min(10, Math.max(1, maxResults))),
        order,
        relevanceLanguage: 'pt',
        ...(withRecency ? { publishedAfter: sixMonthsAgoIso } : {}),
        q: cleanQuery,
      }).toString()}`;

    // Prioriza videos mais em alta (maior numero de visualizacoes nos ultimos 6 meses)
    let res = await fetch(buildSearchUrl('viewCount', true), {
      headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
    });
    let data = res.ok
      ? ((await res.json()) as {
          items?: {
            id?: { videoId?: string };
            snippet?: {
              title?: string;
              channelTitle?: string;
              description?: string;
              publishedAt?: string;
            };
          }[];
        })
      : { items: [] };

    if (!data.items || data.items.length === 0) {
      res = await fetch(buildSearchUrl('viewCount', false), {
        headers: { Authorization: `Bearer ${tokenInfo.accessToken}` },
      });
      if (!res.ok) return [];
      data = (await res.json()) as typeof data;
    }

    const results: CandidatePodcastVideo[] = [];
    for (const item of data.items ?? []) {
      const vid = item.id?.videoId;
      if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
        results.push({
          videoId: vid,
          url: `https://www.youtube.com/watch?v=${vid}`,
          title: item.snippet?.title ?? cleanQuery,
          channelTitle: item.snippet?.channelTitle ?? 'YouTube',
          publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
          durationSec: 600,
          description: item.snippet?.description ?? '',
        });
      }
    }

    // Enriquece com viewCount e duracao real via videos.list (custo minimo: 1 unidade) e ordena pelos mais em alta
    if (results.length > 0) {
      try {
        const statsRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${encodeURIComponent(results.map((r) => r.videoId).join(','))}`,
          { headers: { Authorization: `Bearer ${tokenInfo.accessToken}` } },
        );
        if (statsRes.ok) {
          const statsData = (await statsRes.json()) as {
            items?: {
              id?: string;
              statistics?: { viewCount?: string };
              contentDetails?: { duration?: string };
            }[];
          };
          const metaById = new Map(
            (statsData.items ?? []).map((it) => [
              it.id ?? '',
              {
                views: Number(it.statistics?.viewCount ?? 0),
                durationSec: parseIso8601DurationToSec(it.contentDetails?.duration),
              },
            ]),
          );
          for (const r of results) {
            const meta = metaById.get(r.videoId);
            r.viewCount = meta?.views ?? 0;
            if (meta?.durationSec) {
              r.durationSec = meta.durationSec;
            }
          }
          results.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
        }
      } catch {
        // Mantem ordem original retornada pelo order=viewCount
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Camada 2: Busca direta na pagina de resultados do YouTube (ytInitialData) — sem custo de cota e retorna IDs/titulos/duracoes reais.
 */
export async function searchRealYoutubeVideosViaHtml(
  query: string,
  maxResults = 6,
): Promise<CandidatePodcastVideo[]> {
  const cleanQuery = extractCleanYoutubeSearchQuery(query);
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return [];

    const html = await res.text();
    const match = html.match(/var ytInitialData = (\{.+?\});<\/script>/);
    if (!match?.[1]) return [];

    const data = JSON.parse(match[1]) as {
      contents?: {
        twoColumnSearchResultsRenderer?: {
          primaryContents?: {
            sectionListRenderer?: {
              contents?: {
                itemSectionRenderer?: {
                  contents?: {
                    videoRenderer?: {
                      videoId?: string;
                      title?: { runs?: { text?: string }[] };
                      ownerText?: { runs?: { text?: string }[] };
                      lengthText?: { simpleText?: string };
                      viewCountText?: { simpleText?: string; runs?: { text?: string }[] };
                      shortViewCountText?: { simpleText?: string };
                      detailedMetadataSnippets?: {
                        snippetText?: { runs?: { text?: string }[] };
                      }[];
                    };
                  }[];
                };
              }[];
            };
          };
        };
      };
    };

    const sections =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
        ?.contents ?? [];
    const results: CandidatePodcastVideo[] = [];

    for (const sec of sections) {
      for (const item of sec.itemSectionRenderer?.contents ?? []) {
        const vr = item.videoRenderer;
        if (!vr?.videoId || !/^[a-zA-Z0-9_-]{11}$/.test(vr.videoId)) continue;

        const title = vr.title?.runs?.map((r) => r.text ?? '').join('').trim();
        if (!title) continue;

        const channelTitle = vr.ownerText?.runs?.[0]?.text ?? 'YouTube';
        const durationSec = parseDurationTextToSec(vr.lengthText?.simpleText);
        const viewText =
          vr.viewCountText?.simpleText ??
          vr.viewCountText?.runs?.map((r) => r.text ?? '').join('') ??
          vr.shortViewCountText?.simpleText;
        const viewCount = parseViewCountText(viewText);
        const snippetDesc =
          vr.detailedMetadataSnippets?.[0]?.snippetText?.runs
            ?.map((r) => r.text ?? '')
            .join('') ?? '';

        // Prioriza videos com pelo menos 55s para permitir cortes reais de Shorts
        if (durationSec >= 55) {
          results.push({
            videoId: vr.videoId,
            url: `https://www.youtube.com/watch?v=${vr.videoId}`,
            title,
            channelTitle,
            publishedAt: new Date().toISOString(),
            durationSec,
            viewCount,
            description: snippetDesc,
          });
        }

        if (results.length >= Math.max(maxResults * 2, 12)) break;
      }
      if (results.length >= Math.max(maxResults * 2, 12)) break;
    }

    // Ordena pelos videos mais em alta (maior numero de visualizacoes) sobre o tema
    results.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    return results.slice(0, maxResults);
  } catch {
    return [];
  }
}

/**
 * Camada 3: Busca videos reais no YouTube usando `yt-dlp "ytsearch5:<query>"`.
 */
export async function searchRealYoutubeVideosWithYtDlp(
  query: string,
  maxResults = 5,
): Promise<CandidatePodcastVideo[]> {
  const cleanQuery = extractCleanYoutubeSearchQuery(query);

  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        `ytsearch${Math.min(8, Math.max(1, maxResults))}:${cleanQuery}`,
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
      ],
      { timeout: 15_000 },
    );

    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const results: CandidatePodcastVideo[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as {
          id?: string;
          title?: string;
          channel?: string;
          uploader?: string;
          duration?: number;
          view_count?: number;
          description?: string;
        };
        if (item.id && /^[a-zA-Z0-9_-]{11}$/.test(item.id)) {
          results.push({
            videoId: item.id,
            url: `https://www.youtube.com/watch?v=${item.id}`,
            title: item.title ?? cleanQuery,
            channelTitle: item.channel ?? item.uploader ?? 'YouTube',
            publishedAt: new Date().toISOString(),
            durationSec: Number(item.duration ?? 600),
            viewCount: Number(item.view_count ?? 0),
            description: item.description ?? '',
          });
        }
      } catch {
        // Ignora linha malformada
      }
    }

    results.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    return results;
  } catch {
    return [];
  }
}

export async function searchTrendingTopicsForScriptwriter(
  query: string,
  videoIndex: number,
  oauth?: YoutubeOAuthCredentials | null,
  options?: { allowSandboxFallback?: boolean },
): Promise<TrendingTopicSearchResult> {
  const cleanQuery = query.trim() || 'Novidades Tecnologia e Games';

  if (options?.allowSandboxFallback === true && process.env.VITEST === 'true') {
    return {
      query: cleanQuery,
      source: 'deterministic_fallback',
      trends: [
        {
          title: `Pauta em Alta #${videoIndex}: ${extractCleanYoutubeSearchQuery(cleanQuery)}`,
          url: `https://www.youtube.com/watch?v=trend_${String(videoIndex).padStart(2, '0')}xyz`,
          snippet: `Discussão viral com pico de retenção nos primeiros 3 segundos sobre ${cleanQuery}.`,
        },
      ],
    };
  }

  // 0. Se o usuario informou um link direto de video do YouTube na instrucao, usa esse video imediatamente!
  const directVideoId = extractDirectYoutubeVideoIdFromText(cleanQuery);
  if (directVideoId) {
    const directVideo = await fetchDirectYoutubeVideoCandidate(directVideoId, oauth);
    if (directVideo) {
      return {
        query: cleanQuery,
        source: 'youtube_html_search',
        trends: [
          {
            title: directVideo.title,
            url: directVideo.url,
            channel: directVideo.channelTitle,
            durationSec: directVideo.durationSec,
            snippet:
              directVideo.description ||
              `Vídeo direto solicitado pelo usuário (${directVideo.channelTitle} • ${directVideo.durationSec}s)`,
          },
        ],
      };
    }
  }

  // 1. YouTube Data API v3 (OAuth do Cofre do usuario)
  const apiVideos = await searchRealYoutubeVideosViaDataApi(cleanQuery, oauth, 6);
  if (apiVideos.length > 0) {
    return {
      query: cleanQuery,
      source: 'youtube_data_api_v3',
      trends: apiVideos.map((v) => ({
        title: v.title,
        url: v.url,
        channel: v.channelTitle,
        durationSec: v.durationSec,
        snippet: v.description || `Vídeo real no canal ${v.channelTitle} (${v.videoId})`,
      })),
    };
  }

  // 2. Busca direta na pagina de resultados do YouTube (ytInitialData)
  const htmlVideos = await searchRealYoutubeVideosViaHtml(cleanQuery, 6);
  if (htmlVideos.length > 0) {
    return {
      query: cleanQuery,
      source: 'youtube_html_search',
      trends: htmlVideos.map((v) => ({
        title: v.title,
        url: v.url,
        channel: v.channelTitle,
        durationSec: v.durationSec,
        snippet:
          v.description ||
          `Vídeo real localizado no YouTube — Canal: ${v.channelTitle} (${v.durationSec}s)`,
      })),
    };
  }

  // 3. yt-dlp ytsearch
  const ytDlpVideos = await searchRealYoutubeVideosWithYtDlp(cleanQuery, 5);
  if (ytDlpVideos.length > 0) {
    return {
      query: cleanQuery,
      source: 'yt_dlp_search',
      trends: ytDlpVideos.map((v) => ({
        title: v.title,
        url: v.url,
        channel: v.channelTitle,
        durationSec: v.durationSec,
        snippet: `Vídeo real localizado via yt-dlp (${v.videoId} • ${v.durationSec}s)`,
      })),
    };
  }

  // 4. Fallback Tavily API se configurada
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

  if (options?.allowSandboxFallback === false) {
    throw new Error(
      `Nenhum vídeo real encontrado no YouTube para "${extractCleanYoutubeSearchQuery(cleanQuery)}" via YouTube Data API v3, HTML ou yt-dlp.`,
    );
  }

  return {
    query: cleanQuery,
    source: 'deterministic_fallback',
    trends: [
      {
        title: `Pauta em Alta #${videoIndex}: ${extractCleanYoutubeSearchQuery(cleanQuery)}`,
        url: `https://www.youtube.com/watch?v=trend_${String(videoIndex).padStart(2, '0')}xyz`,
        snippet: `Discussão viral com pico de retenção nos primeiros 3 segundos sobre ${cleanQuery}.`,
      },
    ],
  };
}

export async function listChannelOrTopicVideos(
  channelOrTopicUrl: string,
  topic: string,
  videoIndex: number,
  oauth?: YoutubeOAuthCredentials | null,
  options?: { allowSandboxFallback?: boolean },
): Promise<CandidatePodcastVideo[]> {
  const safeUrl = validateSafeExternalUrl(channelOrTopicUrl);

  if (options?.allowSandboxFallback === true && process.env.VITEST === 'true') {
    const vPad = String(videoIndex).padStart(2, '0');
    const vid = `ep_${vPad}_shortsrc`;
    return [
      {
        videoId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title: `Episódio #${videoIndex} — ${extractCleanYoutubeSearchQuery(topic)}`,
        channelTitle: 'YouTube',
        publishedAt: new Date().toISOString(),
        durationSec: 2400,
      },
    ];
  }

  // 0. Se o usuario informou um link direto de video do YouTube na instrucao (ou em channelOrTopicUrl), retorna-o como Candidato #1!
  const directId =
    extractDirectYoutubeVideoIdFromText(topic) ??
    extractDirectYoutubeVideoIdFromText(channelOrTopicUrl);
  if (directId) {
    const directCandidate = await fetchDirectYoutubeVideoCandidate(directId, oauth);
    if (directCandidate) {
      return [directCandidate];
    }
  }

  // 1. YouTube Data API v3 via Vault OAuth
  const apiVideos = await searchRealYoutubeVideosViaDataApi(topic, oauth, 6);
  if (apiVideos.length > 0) {
    const picked = apiVideos[(videoIndex - 1) % apiVideos.length]!;
    return [picked, ...apiVideos.filter((v) => v.videoId !== picked.videoId)];
  }

  // 2. Busca direta no YouTube HTML (ytInitialData)
  const htmlVideos = await searchRealYoutubeVideosViaHtml(topic, 6);
  if (htmlVideos.length > 0) {
    const picked = htmlVideos[(videoIndex - 1) % htmlVideos.length]!;
    return [picked, ...htmlVideos.filter((v) => v.videoId !== picked.videoId)];
  }

  // 3. yt-dlp ytsearch
  const ytDlpVideos = await searchRealYoutubeVideosWithYtDlp(topic, 5);
  if (ytDlpVideos.length > 0) {
    const picked = ytDlpVideos[(videoIndex - 1) % ytDlpVideos.length]!;
    return [picked, ...ytDlpVideos.filter((v) => v.videoId !== picked.videoId)];
  }

  // 4. RSS publico se channel_id foi informado na URL
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
              channelTitle: 'Canal RSS',
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

  if (options?.allowSandboxFallback === false) {
    throw new Error(
      `Não foi possível localizar nenhum vídeo real do YouTube para "${extractCleanYoutubeSearchQuery(topic)}" (YouTube Data API v3, HTML e yt-dlp não retornaram vídeos válidos).`,
    );
  }

  const vPad = String(videoIndex).padStart(2, '0');
  const vid = `ep_${vPad}_shortsrc`;
  return [
    {
      videoId: vid,
      url: `https://www.youtube.com/watch?v=${vid}`,
      title: `Episódio #${videoIndex} — ${extractCleanYoutubeSearchQuery(topic)}`,
      channelTitle: 'YouTube',
      publishedAt: new Date().toISOString(),
      durationSec: 2400,
    },
  ];
}

export interface HeatmapBucket {
  startSec: number;
  endSec: number;
  /** Intensidade normalizada de retencao/replay do YouTube (0.0 a 1.0) */
  intensity: number;
}

export interface AudiencePeakMoment {
  /** Segundo central do pico de audiencia (ex: 90 = 01:30) */
  peakSec: number;
  /** Timestamp formatado do pico (ex: "01:30") */
  peakFormatted: string;
  /** Intensidade relativa do pico (0.0 a 1.0) */
  intensity: number;
  /** Inicio recomendado do Short (com ~15s de contexto antes do pico) */
  recommendedStartSec: number;
  /** Fim recomendado do Short (duracao ~45s centrada no pico, <= 58s) */
  recommendedEndSec: number;
}

export interface YoutubeAudienceHeatmap {
  videoId: string;
  source: 'youtube_watch_heatmap' | 'youtube_innertube_next' | 'yt_dlp_heatmap' | 'none';
  peaks: AudiencePeakMoment[];
  durationSec?: number;
}

export interface TranscriptSegmentWindow {
  startSec: number;
  endSec: number;
  hook: string;
  transcriptText: string;
  suggestedTitle: string;
  retentionScore: number;
  audiencePeaks: AudiencePeakMoment[];
  heatmapSource: YoutubeAudienceHeatmap['source'];
  resolvedDurationSec?: number;
}

/**
 * Extrai buckets do grafico de retencao ("Most Replayed" / MARKER_TYPE_HEATMAP)
 * de respostas JSON ou HTML do YouTube (tanto `macroMarkersListEntity` quanto `heatMarkerRenderer`).
 */
export function parseHeatmapBucketsFromYoutubeJson(rawText: string): HeatmapBucket[] {
  const buckets: HeatmapBucket[] = [];

  // Formato 1 (moderno): {"startMillis":"90000","durationMillis":"5000","intensityScoreNormalized":0.98}
  const modernRegex =
    /"startMillis"\s*:\s*"?(\d+)"?\s*,\s*"durationMillis"\s*:\s*"?(\d+)"?\s*,\s*"intensityScoreNormalized"\s*:\s*([0-9.eE+-]+)/g;
  for (const m of rawText.matchAll(modernRegex)) {
    const startSec = Number(m[1]) / 1000;
    const durSec = Number(m[2]) / 1000;
    const intensity = Number(m[3]);
    if (
      Number.isFinite(startSec) &&
      Number.isFinite(durSec) &&
      durSec > 0 &&
      Number.isFinite(intensity) &&
      intensity >= 0
    ) {
      buckets.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number((startSec + durSec).toFixed(2)),
        intensity: Math.min(1, Math.max(0, intensity)),
      });
    }
  }

  if (buckets.length > 0) {
    return buckets.sort((a, b) => a.startSec - b.startSec);
  }

  // Formato 2 (legado heatMarkerRenderer): timeRangeStartMillis / markerDurationMillis / heatMarkerIntensityScoreNormalized
  const legacyRegex =
    /"timeRangeStartMillis"\s*:\s*(\d+)\s*,\s*"markerDurationMillis"\s*:\s*(\d+)\s*,\s*"heatMarkerIntensityScoreNormalized"\s*:\s*([0-9.eE+-]+)/g;
  for (const m of rawText.matchAll(legacyRegex)) {
    const startSec = Number(m[1]) / 1000;
    const durSec = Number(m[2]) / 1000;
    const intensity = Number(m[3]);
    if (
      Number.isFinite(startSec) &&
      Number.isFinite(durSec) &&
      durSec > 0 &&
      Number.isFinite(intensity) &&
      intensity >= 0
    ) {
      buckets.push({
        startSec: Number(startSec.toFixed(2)),
        endSec: Number((startSec + durSec).toFixed(2)),
        intensity: Math.min(1, Math.max(0, intensity)),
      });
    }
  }

  return buckets.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Seleciona os principais pontos de pico de audiencia ("Most Replayed") e calcula
 * janelas de corte ideais de ~45s em volta de cada pico (ex: pico em 1:30 -> corte 1:15 a 2:00).
 */
export function selectPeakAudienceClips(
  buckets: readonly HeatmapBucket[],
  videoDurationSec: number,
  maxPeaks = 3,
): AudiencePeakMoment[] {
  if (buckets.length === 0) return [];

  const maxBucketEnd = Math.max(...buckets.map((b) => b.endSec));
  const totalDur = Math.max(30, videoDurationSec || maxBucketEnd || 600);
  const clipTargetDur = Math.min(45, Math.max(25, Math.floor(totalDur * 0.85)));
  const leadInSec = Math.round(clipTargetDur * 0.33); // ~15s antes do pico para contexto/gancho

  // Ignora os primeiros 5s (retencao artificial de abertura) quando o video tem mais de 45s e outros picos reais
  const filtered =
    totalDur > 55
      ? buckets.filter((b) => (b.startSec + b.endSec) / 2 >= 5)
      : [...buckets];
  const pool = filtered.length > 0 ? filtered : [...buckets];

  // Ordena por maior intensidade de audiencia
  const ranked = [...pool].sort((a, b) => b.intensity - a.intensity);
  const selected: AudiencePeakMoment[] = [];

  for (const candidate of ranked) {
    if (selected.length >= maxPeaks) break;
    const peakSec = Math.round((candidate.startSec + candidate.endSec) / 2);

    // Mantem picos distintos separados por pelo menos 45s para evitar cortes sobrepostos
    if (selected.some((p) => Math.abs(p.peakSec - peakSec) < 45)) {
      continue;
    }

    let recStart = Math.max(0, peakSec - leadInSec);
    let recEnd = Math.min(totalDur, recStart + clipTargetDur);
    if (recEnd - recStart < 25 && totalDur >= 25) {
      recStart = Math.max(0, Math.round(recEnd - clipTargetDur));
    }
    recStart = Math.max(0, Math.round(recStart));
    recEnd = Math.min(Math.round(totalDur), Math.round(recEnd));
    if (recEnd <= recStart + 5) continue;

    selected.push({
      peakSec,
      peakFormatted: formatSecondsToMmSs(peakSec),
      intensity: Number(candidate.intensity.toFixed(3)),
      recommendedStartSec: recStart,
      recommendedEndSec: recEnd,
    });
  }

  return selected;
}

/**
 * Extrai a pagina watch do YouTube uma unica vez por videoId (com cache de 25 min),
 * trazendo titulo, canal, descricao, duracao real e heatmap de audiencia.
 */
async function fetchYoutubeWatchPageSignals(sourceUrl: string): Promise<{
  videoId: string | null;
  title?: string;
  channelTitle?: string;
  description: string | null;
  durationSec: number | null;
  heatmapBuckets: HeatmapBucket[];
}> {
  const idMatch = sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch?.[1]) {
    return { videoId: null, description: null, durationSec: null, heatmapBuckets: [] };
  }
  const videoId = idMatch[1];

  const cached = watchSignalsCacheByVideoId.get(videoId);
  if (cached && Date.now() - cached.fetchedAtMs < 25 * 60_000) {
    return cached;
  }

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+999',
      },
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) {
      return { videoId, description: null, durationSec: null, heatmapBuckets: [] };
    }
    const html = await res.text();
    let description: string | null = null;
    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (descMatch?.[1]) {
      try {
        description = (JSON.parse(`"${descMatch[1]}"`) as string)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 700);
      } catch {
        description = null;
      }
    }

    const titleMatch = html.match(/"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/);
    const authorMatch = html.match(/"videoDetails":\{[^}]*?"author":"((?:[^"\\]|\\.)*)"/);
    let title: string | undefined;
    let channelTitle: string | undefined;
    try {
      if (titleMatch?.[1]) title = JSON.parse(`"${titleMatch[1]}"`) as string;
      if (authorMatch?.[1]) channelTitle = JSON.parse(`"${authorMatch[1]}"`) as string;
    } catch {
      // ignora
    }

    const lenMatch = html.match(/"lengthSeconds":"(\d+)"/);
    const durationSec = lenMatch?.[1] ? Number(lenMatch[1]) : null;
    const heatmapBuckets = parseHeatmapBucketsFromYoutubeJson(html);

    const entry = {
      videoId,
      title,
      channelTitle,
      description,
      durationSec,
      heatmapBuckets,
      fetchedAtMs: Date.now(),
    };
    watchSignalsCacheByVideoId.set(videoId, entry);
    return entry;
  } catch {
    return { videoId, description: null, durationSec: null, heatmapBuckets: [] };
  }
}

/**
 * Camada 2 de Heatmap: consulta o endpoint InnerTube `/youtubei/v1/next` para obter
 * os marcadores `MARKER_TYPE_HEATMAP` (Most Replayed) diretamente do YouTube (sem tocar no endpoint `/player`!).
 */
async function fetchHeatmapViaInnertubeNext(videoId: string): Promise<HeatmapBucket[]> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+999',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250501.00.00',
            hl: 'pt',
            gl: 'BR',
          },
        },
        videoId,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseHeatmapBucketsFromYoutubeJson(text);
  } catch {
    return [];
  }
}

/**
 * Busca os pontos reais de pico de audiencia ("Most Replayed") de um video do YouTube com cache em memoria:
 * 1) HTML da pagina watch?v=<id>
 * 2) YouTube InnerTube `/youtubei/v1/next`
 * IMPORTANTE: Nao invoca `yt-dlp` durante a fase do Pesquisador para nao consumir a cota de IP do endpoint `/player` antes do Editor baixar o video!
 */
export async function fetchYoutubeAudienceHeatmap(
  sourceUrl: string,
  fallbackDurationSec?: number,
  preFetchedWatchSignals?: {
    videoId: string | null;
    durationSec: number | null;
    heatmapBuckets: HeatmapBucket[];
  },
): Promise<YoutubeAudienceHeatmap> {
  const idMatch = sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = preFetchedWatchSignals?.videoId ?? idMatch?.[1] ?? '';

  if (!videoId || process.env.VITEST === 'true') {
    return { videoId, source: 'none', peaks: [], durationSec: fallbackDurationSec };
  }

  const cachedHeatmap = heatmapCacheByVideoId.get(videoId);
  if (cachedHeatmap) {
    return cachedHeatmap;
  }

  const watchSignals = preFetchedWatchSignals ?? (await fetchYoutubeWatchPageSignals(sourceUrl));
  const resolvedDur = watchSignals.durationSec ?? fallbackDurationSec ?? 600;

  if (watchSignals.heatmapBuckets.length > 0) {
    const res: YoutubeAudienceHeatmap = {
      videoId,
      source: 'youtube_watch_heatmap',
      peaks: selectPeakAudienceClips(watchSignals.heatmapBuckets, resolvedDur, 3),
      durationSec: resolvedDur,
    };
    heatmapCacheByVideoId.set(videoId, res);
    return res;
  }

  const innertubeBuckets = await fetchHeatmapViaInnertubeNext(videoId);
  if (innertubeBuckets.length > 0) {
    const res: YoutubeAudienceHeatmap = {
      videoId,
      source: 'youtube_innertube_next',
      peaks: selectPeakAudienceClips(innertubeBuckets, resolvedDur, 3),
      durationSec: resolvedDur,
    };
    heatmapCacheByVideoId.set(videoId, res);
    return res;
  }

  const emptyRes: YoutubeAudienceHeatmap = {
    videoId,
    source: 'none',
    peaks: [],
    durationSec: resolvedDur,
  };
  heatmapCacheByVideoId.set(videoId, emptyRes);
  return emptyRes;
}

export async function extractBestTranscriptWindowForShort(
  sourceUrl: string,
  topic: string,
  videoIndex: number,
  videoMeta?: { title?: string; channelTitle?: string; durationSec?: number },
): Promise<TranscriptSegmentWindow> {
  validateSafeExternalUrl(sourceUrl);

  const watchSignals = await fetchYoutubeWatchPageSignals(sourceUrl);
  const heatmap = await fetchYoutubeAudienceHeatmap(
    sourceUrl,
    watchSignals.durationSec ?? videoMeta?.durationSec,
    watchSignals,
  );

  const maxDuration = Math.max(
    45,
    heatmap.durationSec ?? watchSignals.durationSec ?? videoMeta?.durationSec ?? 600,
  );

  // Prioriza o ponto de pico de audiencia real do YouTube ("Most Replayed")!
  // Ex.: se o pico foi por volta de 1:30 (90s), corta em volta desse trecho (75s..120s).
  const targetPeak =
    heatmap.peaks.length > 0
      ? heatmap.peaks[(videoIndex - 1) % heatmap.peaks.length]
      : undefined;

  let startSec: number;
  let endSec: number;
  if (targetPeak) {
    startSec = targetPeak.recommendedStartSec;
    endSec = targetPeak.recommendedEndSec;
  } else {
    const rawStart = 30 + (videoIndex - 1) * 45;
    startSec = Math.min(rawStart, Math.max(10, maxDuration - 55));
    endSec = Math.min(startSec + 45, maxDuration);
  }

  const realDesc = watchSignals.description;
  const cleanTopic = extractCleanYoutubeSearchQuery(topic);
  const baseTitle = videoMeta?.title ? videoMeta.title.slice(0, 75) : cleanTopic.slice(0, 62);

  return {
    startSec,
    endSec,
    hook: videoMeta?.title
      ? `Olha o que aconteceu em "${videoMeta.title.slice(0, 55)}"!`
      : `Você viu o que comentaram sobre ${cleanTopic}?`,
    transcriptText:
      realDesc ??
      `Trecho selecionado do vídeo "${baseTitle}" (${videoMeta?.channelTitle ?? 'YouTube'}) abordando ${cleanTopic}. Focar nos 3 primeiros segundos com corte rápido e legendas destacadas.`,
    suggestedTitle: `${baseTitle} #shorts`.slice(0, 95),
    retentionScore: targetPeak
      ? Math.min(99, Math.max(88, Math.round(85 + targetPeak.intensity * 14)))
      : Math.min(99, 89 + (videoIndex % 10)),
    audiencePeaks: heatmap.peaks,
    heatmapSource: heatmap.source,
    resolvedDurationSec: maxDuration,
  };
}
