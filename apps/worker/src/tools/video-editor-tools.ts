import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LlmProvider } from '@workoffice/shared';
import { validateSafeExternalUrl } from './scriptwriter-tools.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface VideoSegmentSpec {
  sourceUrl: string;
  startSec: number;
  endSec: number;
}

export interface SpokenSubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface EditorSubtitleStyle {
  accentColor?: 'yellow' | 'red' | 'white' | 'green';
  highlightWords?: string[];
  applyDynamicZoom?: boolean;
}

export interface ExtractedSpokenTranscript {
  language: string;
  source:
    | 'yt_dlp_subtitles'
    | 'faster_whisper_local'
    | 'openai_whisper'
    | 'gemini_audio'
    | 'sandbox_synthetic'
    | 'none';
  cues: SpokenSubtitleCue[];
}

export function validateShortClipDuration(startSec: number, endSec: number): number {
  const duration = endSec - startSec;
  if (duration <= 0 || duration > 60) {
    throw new Error(
      `Duração inválida para YouTube Short (${duration}s). O corte deve ter entre 1s e 60s.`,
    );
  }
  return duration;
}

/**
 * Formata segundos em timestamp SRT padrao (HH:MM:SS,mmm).
 */
export function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;

  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Converte timestamp SRT/VTT (HH:MM:SS.mmm, HH:MM:SS,mmm ou MM:SS.mmm) em segundos.
 */
function parseSubtitleTimestampToSec(raw: string): number | null {
  const normalized = raw.trim().replace(',', '.');
  const parts = normalized.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  return null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function cleanCaptionLine(raw: string): string {
  return decodeHtmlEntities(
    raw
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?c(?:\.[^>]*)?>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[(?:music|música|applause|aplausos|laughter|risos)\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Faz parsing de arquivos .vtt ou .srt (incluindo legendas rolling auto-geradas do YouTube),
 * filtra apenas as falas dentro de [clipStartSec, clipEndSec], reajusta timestamps para 0..duracao,
 * remove duplicacoes e divide em blocos curtos ideais para Shorts.
 */
export function parseSubtitleTextToCues(
  rawContent: string,
  clipStartSec: number,
  clipEndSec: number,
): SpokenSubtitleCue[] {
  const durationSec = Math.max(1, clipEndSec - clipStartSec);
  const blocks = rawContent
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/);

  const rawCues: SpokenSubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;

    const tsLine = lines[tsIdx]!;
    const [startRaw, endAndSettings] = tsLine.split('-->');
    if (!startRaw || !endAndSettings) continue;

    const endRaw = endAndSettings.trim().split(/\s+/)[0] ?? '';
    const absStart = parseSubtitleTimestampToSec(startRaw);
    const absEnd = parseSubtitleTimestampToSec(endRaw);
    if (absStart === null || absEnd === null || absEnd <= absStart) continue;

    // Ignora falas completamente fora da janela do corte
    if (absEnd <= clipStartSec + 0.05 || absStart >= clipEndSec - 0.05) continue;

    const textLines = lines
      .slice(tsIdx + 1)
      .map(cleanCaptionLine)
      .filter(Boolean);
    const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const relStart = Math.max(0, Number((absStart - clipStartSec).toFixed(3)));
    const relEnd = Math.min(durationSec, Number((absEnd - clipStartSec).toFixed(3)));
    if (relEnd - relStart < 0.08) continue;

    // Evita duplicacao tipica do VTT rolling do YouTube (onde a linha anterior se repete no bloco seguinte)
    const prev = rawCues[rawCues.length - 1];
    if (prev) {
      const prevNorm = prev.text.toLowerCase();
      const currNorm = text.toLowerCase();
      if (currNorm === prevNorm) {
        prev.endSec = Math.max(prev.endSec, relEnd);
        continue;
      }
      if (currNorm.startsWith(prevNorm) && text.length > prev.text.length) {
        const delta = text.slice(prev.text.length).trim();
        if (delta.length > 0) {
          rawCues.push({ startSec: relStart, endSec: relEnd, text: delta });
          continue;
        }
      }
    }

    rawCues.push({ startSec: relStart, endSec: relEnd, text });
  }

  // Rechunk para blocos curtos de 3-6 palavras por legenda (leitura rapida em Shorts)
  const chunked: SpokenSubtitleCue[] = [];
  for (const cue of rawCues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length <= 6 && cue.text.length <= 38) {
      chunked.push(cue);
      continue;
    }

    const parts: string[] = [];
    let buf: string[] = [];
    for (const w of words) {
      const cand = [...buf, w].join(' ');
      if (buf.length >= 5 || (buf.length > 0 && cand.length > 34)) {
        parts.push(buf.join(' '));
        buf = [w];
      } else {
        buf.push(w);
      }
    }
    if (buf.length > 0) parts.push(buf.join(' '));

    const span = Math.max(0.25, cue.endSec - cue.startSec);
    const step = span / parts.length;
    parts.forEach((p, idx) => {
      const s = Number((cue.startSec + idx * step).toFixed(3));
      const e = Number(Math.min(durationSec, cue.startSec + (idx + 1) * step - 0.03).toFixed(3));
      if (e > s) {
        chunked.push({ startSec: s, endSec: e, text: p });
      }
    });
  }

  return chunked;
}

/**
 * Converte falas reais com timestamps em conteudo .srt valido, aplicando enfase
 * apenas nas palavras-chave indicadas pelas instrucoes de edicao (sem alterar o idioma nem inventar falas).
 */
export function formatCuesToSrt(
  cues: readonly SpokenSubtitleCue[],
  style?: EditorSubtitleStyle,
): string {
  if (cues.length === 0) return '';

  const highlightSet = new Set(
    (style?.highlightWords ?? [])
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 2),
  );

  const accentTag =
    style?.accentColor === 'red'
      ? '{\\c&H0000FF&}'
      : style?.accentColor === 'green'
        ? '{\\c&H00FF00&}'
        : style?.accentColor === 'white'
          ? '{\\c&HFFFFFF&}'
          : '{\\c&H00FFFF&}';

  const applyHighlights = (text: string): string => {
    if (highlightSet.size === 0) return text;
    let out = text;
    for (const kw of highlightSet) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${escaped})`, 'gi');
      out = out.replace(re, (match) => `${accentTag}${match.toUpperCase()}{\\r}`);
    }
    return out;
  };

  return cues
    .map((cue, idx) => {
      const safeStart = Math.max(0, cue.startSec);
      const safeEnd = Math.max(safeStart + 0.15, cue.endSec);
      return `${idx + 1}\n${formatSrtTimestamp(safeStart)} --> ${formatSrtTimestamp(safeEnd)}\n${applyHighlights(cue.text.trim())}\n`;
    })
    .join('\n');
}

/**
 * Gera conteudo .srt deterministico (usado exclusivamente em modo Sandbox / testes unitarios).
 */
export function buildDynamicSrtSubtitles(
  hookText: string,
  bodyText: string,
  durationSec: number,
): string {
  const safeDuration = Math.min(60, Math.max(6, durationSec));
  const sentences = [
    hookText.trim(),
    ...bodyText
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ].filter(Boolean);

  const count = Math.max(1, sentences.length);
  const windowSec = safeDuration / count;

  return sentences
    .map((sentence, idx) => {
      const start = idx * windowSec;
      const end = Math.min(safeDuration, (idx + 1) * windowSec - 0.08);
      return `${idx + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${sentence}\n`;
    })
    .join('\n');
}

/**
 * Detecta o idioma falado ORIGINAL do video no YouTube (ex: "pt", "en", "es")
 * inspecionando a faixa ASR (auto-generated) do InnerTube ANDROID player.
 * Nunca traduz: garante que videos em portugues fiquem em portugues e em ingles fiquem em ingles.
 */
export async function detectYoutubeOriginalLanguage(sourceUrl: string): Promise<string | null> {
  const idMatch = sourceUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch?.[1]) return null;

  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            androidSdkVersion: 34,
            hl: 'en',
            gl: 'US',
          },
        },
        videoId: idMatch[1],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      captions?: {
        playerCaptionsTracklistRenderer?: {
          captionTracks?: { languageCode?: string; kind?: string }[];
        };
      };
    };

    const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) return null;

    // A faixa `kind === 'asr'` sempre representa o idioma real do audio original falado no video!
    const asrTrack = tracks.find((t) => t.kind === 'asr' && t.languageCode);
    const rawLang = asrTrack?.languageCode ?? tracks[0]?.languageCode ?? null;
    return rawLang ? rawLang.split('-')[0]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Monta os argumentos reais do `yt-dlp` para baixar apenas o segmento especifico (start-end).
 */
export function buildYtDlpSegmentArgs(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputTemplatePath: string;
}): string[] {
  validateSafeExternalUrl(params.sourceUrl, { enforceAllowedMediaHost: true });
  validateShortClipDuration(params.startSec, params.endSec);

  return [
    '--no-playlist',
    '--extractor-args',
    'youtube:player_client=android,web',
    '--download-sections',
    `*${params.startSec}-${params.endSec}`,
    '-f',
    'mp4[height<=1080]/best[ext=mp4]/best',
    '-o',
    params.outputTemplatePath,
    params.sourceUrl,
  ];
}

/**
 * Baixa o trecho real [startSec, endSec] do YouTube usando yt-dlp para um arquivo temporario.
 */
export async function downloadVideoSegmentToFile(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const isRealYoutubeWatchUrl =
    /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}/.test(params.sourceUrl) ||
    /^https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}/.test(params.sourceUrl);

  if (!isRealYoutubeWatchUrl) {
    return {
      ok: false,
      reason: `URL de origem inválida ou não é um vídeo real do YouTube: ${params.sourceUrl}`,
    };
  }

  try {
    const ytdlpArgs = buildYtDlpSegmentArgs({
      sourceUrl: params.sourceUrl,
      startSec: params.startSec,
      endSec: params.endSec,
      outputTemplatePath: params.outputPath,
    });
    await execFileAsync('yt-dlp', ytdlpArgs, { timeout: 75_000 });
    const stat = await fs.stat(params.outputPath).catch(() => null);
    if (stat && stat.size > 4096) {
      return { ok: true };
    }
    return { ok: false, reason: 'Arquivo baixado pelo yt-dlp ficou vazio (< 4 KB).' };
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message?.slice(0, 260) ?? 'Erro desconhecido no yt-dlp',
    };
  }
}

/**
 * Camada 1: Baixa legendas nativas/automaticas do YouTube via yt-dlp EXCLUSIVAMENTE no idioma original do video.
 */
async function tryExtractSubtitlesViaYtDlp(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  originalLang: string | null;
  workDir: string;
}): Promise<ExtractedSpokenTranscript | null> {
  const subDir = path.join(params.workDir, 'subs');
  await fs.mkdir(subDir, { recursive: true });

  const langArg = params.originalLang
    ? `${params.originalLang},${params.originalLang}-.*`
    : 'pt,pt-BR,en,en-US,es';

  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--no-playlist',
        '--skip-download',
        '--extractor-args',
        'youtube:player_client=android,web',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        langArg,
        '--sub-format',
        'vtt/srt/best',
        '-o',
        path.join(subDir, 'cap.%(ext)s'),
        params.sourceUrl,
      ],
      { timeout: 30_000 },
    );

    const files = await fs.readdir(subDir);
    const subFiles = files.filter((f) => f.endsWith('.vtt') || f.endsWith('.srt'));
    if (subFiles.length === 0) return null;

    // Prioriza arquivo que corresponda exatamente ao idioma original detectado
    const preferred =
      (params.originalLang
        ? subFiles.find((f) => f.toLowerCase().includes(`.${params.originalLang}.`))
        : undefined) ?? subFiles[0]!;

    const raw = await fs.readFile(path.join(subDir, preferred), 'utf8');
    const cues = parseSubtitleTextToCues(raw, params.startSec, params.endSec);
    if (cues.length === 0) return null;

    const langMatch = preferred.match(/\.([a-z]{2}(?:-[A-Za-z]{2})?)\.(?:vtt|srt)$/i);
    const detectedLang = (params.originalLang ?? langMatch?.[1] ?? 'unknown')
      .split('-')[0]!
      .toLowerCase();

    return {
      language: detectedLang,
      source: 'yt_dlp_subtitles',
      cues,
    };
  } catch {
    return null;
  }
}

/**
 * Camada 2: Transcreve o audio REAL do clipe baixado usando faster-whisper local (Python CPU INT8),
 * com task="transcribe" preservando 100% o idioma falado original (PT->PT, EN->EN).
 */
async function tryTranscribeViaLocalFasterWhisper(params: {
  rawClipPath: string;
  originalLang: string | null;
  workDir: string;
}): Promise<ExtractedSpokenTranscript | null> {
  const wavPath = path.join(params.workDir, 'clip_audio_16k.wav');
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', params.rawClipPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
      { timeout: 30_000 },
    );

    const scriptCandidates = [
      path.resolve(__dirname, '../../scripts/transcribe_clip.py'),
      path.resolve(process.cwd(), 'apps/worker/scripts/transcribe_clip.py'),
      path.resolve(process.cwd(), 'scripts/transcribe_clip.py'),
    ];

    let scriptPath: string | null = null;
    for (const candidate of scriptCandidates) {
      const exists = await fs
        .stat(candidate)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        scriptPath = candidate;
        break;
      }
    }
    if (!scriptPath) return null;

    const pyArgs = [scriptPath, wavPath];
    if (params.originalLang) {
      pyArgs.push(params.originalLang);
    }

    const { stdout } = await execFileAsync('python3', pyArgs, {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const jsonLine = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!jsonLine.startsWith('{')) return null;

    const parsed = JSON.parse(jsonLine) as {
      language?: string;
      cues?: SpokenSubtitleCue[];
    };
    const cues = (parsed.cues ?? []).filter((c) => c.text && c.endSec > c.startSec);
    if (cues.length === 0) return null;

    return {
      language: (parsed.language ?? params.originalLang ?? 'unknown').toLowerCase(),
      source: 'faster_whisper_local',
      cues,
    };
  } catch {
    return null;
  }
}

/**
 * Camada 3: Speech-to-Text via API do provedor (OpenAI Whisper `whisper-1` ou Google Gemini audio),
 * transcrevendo estritamente no idioma falado original (sem traduzir).
 */
async function tryTranscribeViaProviderAudioApi(params: {
  rawClipPath: string;
  originalLang: string | null;
  workDir: string;
  provider?: LlmProvider;
  apiKey?: string;
}): Promise<ExtractedSpokenTranscript | null> {
  if (!params.apiKey || params.apiKey.startsWith('wo_test_')) return null;
  if (params.provider !== 'openai' && params.provider !== 'google') return null;

  const mp3Path = path.join(params.workDir, 'clip_audio.mp3');
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', params.rawClipPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3Path],
      { timeout: 30_000 },
    );
    const audioBuf = await fs.readFile(mp3Path);

    if (params.provider === 'openai') {
      const form = new FormData();
      form.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'clip.mp3');
      form.append('model', 'whisper-1');
      form.append('response_format', 'srt');
      if (params.originalLang) {
        form.append('language', params.originalLang);
      }
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${params.apiKey.trim()}` },
        body: form,
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) return null;
      const srtText = await res.text();
      const cues = parseSubtitleTextToCues(srtText, 0, 60);
      if (cues.length === 0) return null;
      return {
        language: params.originalLang ?? 'unknown',
        source: 'openai_whisper',
        cues,
      };
    }

    if (params.provider === 'google') {
      const b64 = audioBuf.toString('base64');
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': params.apiKey.trim(),
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: 'audio/mp3', data: b64 } },
                  {
                    text: 'Transcribe verbatim every spoken word in this audio clip with exact timestamps in valid SRT format. CRITICAL: Keep the EXACT original spoken language of the speaker (if Portuguese keep Portuguese, if English keep English — NEVER translate). Return ONLY valid SRT blocks.',
                  },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const cues = parseSubtitleTextToCues(text, 0, 60);
      if (cues.length === 0) return null;
      return {
        language: params.originalLang ?? 'unknown',
        source: 'gemini_audio',
        cues,
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Pipeline completo de extracao de falas reais do video no idioma original:
 * 1) Legendas nativas/auto do YouTube no idioma original via yt-dlp
 * 2) Transcricao local do audio baixado via faster-whisper (task="transcribe", preserva idioma original)
 * 3) Transcricao via API de audio do provedor (OpenAI Whisper / Gemini) se disponivel
 * JAMAIS retorna instrucoes do roteirista como legenda!
 */
export async function extractSpokenSubtitlesFromClip(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  rawClipPath?: string;
  workDir: string;
  provider?: LlmProvider;
  apiKey?: string;
  isSandbox?: boolean;
}): Promise<ExtractedSpokenTranscript> {
  if (params.isSandbox) {
    const dur = Math.max(6, params.endSec - params.startSec);
    return {
      language: 'pt',
      source: 'sandbox_synthetic',
      cues: [
        { startSec: 0, endSec: Number((dur * 0.48).toFixed(2)), text: 'Fala real de teste parte 1.' },
        {
          startSec: Number((dur * 0.5).toFixed(2)),
          endSec: Number((dur - 0.1).toFixed(2)),
          text: 'Fala real de teste parte 2.',
        },
      ],
    };
  }

  const originalLang = await detectYoutubeOriginalLanguage(params.sourceUrl);

  // Camada 1: Legendas originais via yt-dlp
  const fromYtDlp = await tryExtractSubtitlesViaYtDlp({
    sourceUrl: params.sourceUrl,
    startSec: params.startSec,
    endSec: params.endSec,
    originalLang,
    workDir: params.workDir,
  });
  if (fromYtDlp && fromYtDlp.cues.length > 0) {
    return fromYtDlp;
  }

  // Camada 2: faster-whisper local sobre o audio real do trecho baixado
  if (params.rawClipPath) {
    const fromWhisper = await tryTranscribeViaLocalFasterWhisper({
      rawClipPath: params.rawClipPath,
      originalLang,
      workDir: params.workDir,
    });
    if (fromWhisper && fromWhisper.cues.length > 0) {
      return fromWhisper;
    }

    // Camada 3: Cloud STT (OpenAI Whisper / Gemini Audio)
    const fromProvider = await tryTranscribeViaProviderAudioApi({
      rawClipPath: params.rawClipPath,
      originalLang,
      workDir: params.workDir,
      provider: params.provider,
      apiKey: params.apiKey,
    });
    if (fromProvider && fromProvider.cues.length > 0) {
      return fromProvider;
    }
  }

  return {
    language: originalLang ?? 'unknown',
    source: 'none',
    cues: [],
  };
}

/**
 * Monta os argumentos reais de linha de comando do `ffmpeg` para:
 * - Recorte da janela de tempo (<= 60s)
 * - Crop central + scale para vertical 9:16 (1080x1920)
 * - Zoom sutil opcional quando solicitado pelas instrucoes do roteirista
 * - Queima (burn-in) opcional de legendas .srt estilizadas
 */
export function buildFfmpegVerticalShortArgs(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  subtitleSrtPath?: string;
  durationSec: number;
  accentColor?: 'yellow' | 'red' | 'white' | 'green';
  applyDynamicZoom?: boolean;
}): string[] {
  const safeDuration = validateShortClipDuration(0, params.durationSec);
  const filters: string[] = [
    params.applyDynamicZoom ? 'crop=ih*9/16*0.92:ih*0.92' : 'crop=ih*9/16:ih',
    'scale=1080:1920:flags=lanczos',
    'setsar=1',
  ];

  const primaryColour =
    params.accentColor === 'red'
      ? '&H00FFFFFF'
      : params.accentColor === 'white'
        ? '&H00FFFFFF'
        : params.accentColor === 'green'
          ? '&H0080FF80'
          : '&H0000FFFF';

  if (params.subtitleSrtPath) {
    const escapedSrt = params.subtitleSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(
      `subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=20,Bold=1,PrimaryColour=${primaryColour},OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=65'`,
    );
  }

  return [
    '-y',
    '-i',
    params.inputVideoPath,
    '-t',
    String(safeDuration),
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    params.outputVideoPath,
  ];
}

/**
 * Gera um buffer MP4 minimo valido (ftyp + moov) quando executado em modo Sandbox/CI
 * onde binarios externos ou download real do YouTube nao estao disponiveis.
 */
export function createMinimalValidMp4Buffer(metadataTag: string): Buffer {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const tagBytes = Buffer.from(`WorkOffice Short 1080x1920 :: ${metadataTag}`, 'utf8');
  const freeBoxHeader = Buffer.alloc(8);
  freeBoxHeader.writeUInt32BE(8 + tagBytes.length, 0);
  freeBoxHeader.write('free', 4, 'ascii');
  return Buffer.concat([ftyp, freeBoxHeader, tagBytes]);
}

export interface RenderedShortPackage {
  mp4Buffer: Buffer;
  srtContent: string;
  durationSec: number;
  resolution: '1080x1920';
  storageVideoPath: string;
  storageSubtitlePath: string;
  usedNativeFfmpeg: boolean;
  subtitleCuesCount: number;
}

/**
 * Executa o pipeline completo de edicao de 1 Short (download -> legenda real da fala -> corte 9:16 + burn-in -> upload Storage).
 */
export async function renderShortVideoPackage(params: {
  officeId: string;
  runId: string;
  taskId: string;
  videoIndex: number;
  sourceUrl: string;
  startSec: number;
  endSec: number;
  hookText: string;
  bodyText: string;
  spokenCues?: readonly SpokenSubtitleCue[];
  subtitleStyle?: EditorSubtitleStyle;
  preDownloadedRawClipPath?: string;
  supabaseStorageClient?: SupabaseClient | null;
  allowSyntheticFallback?: boolean;
}): Promise<RenderedShortPackage> {
  validateSafeExternalUrl(params.sourceUrl);
  const durationSec = validateShortClipDuration(params.startSec, params.endSec);
  const vPad = String(params.videoIndex).padStart(2, '0');
  const storageVideoPath = `${params.officeId}/${params.runId}/short_${vPad}_9x16.mp4`;
  const storageSubtitlePath = `${params.officeId}/${params.runId}/short_${vPad}.srt`;

  // Em producao (allowSyntheticFallback === false), JAMAIS queima hookText/bodyText (instrucoes do roteirista) como legenda!
  // Usa exclusivamente as falas reais transcritas (spokenCues) no idioma original do video.
  const hasRealSpokenCues = Array.isArray(params.spokenCues) && params.spokenCues.length > 0;
  const srtContent = hasRealSpokenCues
    ? formatCuesToSrt(params.spokenCues!, params.subtitleStyle)
    : params.allowSyntheticFallback === false
      ? ''
      : buildDynamicSrtSubtitles(params.hookText, params.bodyText, durationSec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `wo-task-${params.taskId.slice(0, 8)}-`));
  const rawClipFile = params.preDownloadedRawClipPath ?? path.join(tmpDir, `raw_${vPad}.mp4`);
  const srtFile = path.join(tmpDir, `short_${vPad}.srt`);
  const outMp4File = path.join(tmpDir, `short_${vPad}_9x16.mp4`);

  let mp4Buffer: Buffer;
  let usedNativeFfmpeg = false;

  try {
    const hasSubtitlesToBurn = srtContent.trim().length > 0;
    if (hasSubtitlesToBurn) {
      await fs.writeFile(srtFile, srtContent, 'utf8');
    }

    if (process.env.ENABLE_NATIVE_FFMPEG === 'true') {
      let downloadedRealClip = false;
      let ytDlpFailureReason = '';

      if (params.preDownloadedRawClipPath) {
        const preStat = await fs.stat(params.preDownloadedRawClipPath).catch(() => null);
        if (preStat && preStat.size > 4096) {
          downloadedRealClip = true;
        }
      }

      if (!downloadedRealClip) {
        const dl = await downloadVideoSegmentToFile({
          sourceUrl: params.sourceUrl,
          startSec: params.startSec,
          endSec: params.endSec,
          outputPath: rawClipFile,
        });
        downloadedRealClip = dl.ok;
        ytDlpFailureReason = dl.reason ?? '';
      }

      if (downloadedRealClip) {
        try {
          const ffmpegArgs = buildFfmpegVerticalShortArgs({
            inputVideoPath: rawClipFile,
            outputVideoPath: outMp4File,
            subtitleSrtPath: hasSubtitlesToBurn ? srtFile : undefined,
            durationSec,
            accentColor: params.subtitleStyle?.accentColor,
            applyDynamicZoom: params.subtitleStyle?.applyDynamicZoom,
          });
          await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 60_000 });
          mp4Buffer = await fs.readFile(outMp4File);
          usedNativeFfmpeg = true;
        } catch {
          // Se o filtro de legenda libass nao estiver compilado, recorta o video real em 9:16 sem o filtro subtitles
          const fallbackFfmpegArgs = buildFfmpegVerticalShortArgs({
            inputVideoPath: rawClipFile,
            outputVideoPath: outMp4File,
            durationSec,
            applyDynamicZoom: params.subtitleStyle?.applyDynamicZoom,
          });
          await execFileAsync('ffmpeg', fallbackFfmpegArgs, { timeout: 60_000 });
          mp4Buffer = await fs.readFile(outMp4File);
          usedNativeFfmpeg = true;
        }
      } else if (
        params.allowSyntheticFallback === false &&
        process.env.ALLOW_SYNTHETIC_VIDEO_FALLBACK !== 'true'
      ) {
        throw new Error(
          `Editor falhou ao baixar o vídeo real (${params.sourceUrl}) via yt-dlp: ${ytDlpFailureReason}`,
        );
      } else {
        await execFileAsync('ffmpeg', [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=c=0x0f172a:s=1080x1920:d=${Math.min(5, durationSec)}:r=30`,
          '-f',
          'lavfi',
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-shortest',
          '-t',
          String(Math.min(5, durationSec)),
          outMp4File,
        ]);
        mp4Buffer = await fs.readFile(outMp4File);
        usedNativeFfmpeg = true;
      }
    } else {
      mp4Buffer = createMinimalValidMp4Buffer(`${storageVideoPath} (${durationSec}s)`);
    }

    if (params.supabaseStorageClient) {
      await params.supabaseStorageClient.storage
        .from('shorts')
        .upload(storageVideoPath, mp4Buffer, {
          contentType: 'video/mp4',
          upsert: true,
        });

      await params.supabaseStorageClient.storage
        .from('artifacts')
        .upload(storageSubtitlePath, Buffer.from(srtContent, 'utf8'), {
          contentType: 'application/x-subrip',
          upsert: true,
        });
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    mp4Buffer,
    srtContent,
    durationSec,
    resolution: '1080x1920',
    storageVideoPath,
    storageSubtitlePath,
    usedNativeFfmpeg,
    subtitleCuesCount: hasRealSpokenCues ? params.spokenCues!.length : 0,
  };
}
