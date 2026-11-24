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

export type SubtitleTransitionStyle = 'pop' | 'fade_slide' | 'blur_in';
export type CutTransitionStyle = 'fade' | 'smoothleft' | 'smoothright' | 'dissolve';

export interface EditorSubtitleStyle {
  accentColor?: 'yellow' | 'red' | 'white' | 'green' | 'cyan';
  highlightWords?: string[];
  applyDynamicZoom?: boolean;
  /** Variacoes sutis de entrada/saida das legendas ASS alternadas ao longo do Short */
  subtitleTransitions?: SubtitleTransitionStyle[];
  /** Transicao sutil aplicada entre jump-cuts de silencio / mudancas de plano */
  cutTransition?: CutTransitionStyle;
  /** Instantes especificos (em segundos no clipe original) para aplicar punch-in zoom sutil (1.07x) */
  zoomMomentsSec?: number[];
  /** Remove pausas silenciosas >= 0.45s automaticamente */
  removeSilences?: boolean;
}

export interface SilenceInterval {
  startSec: number;
  endSec: number;
}

export interface ActiveEditSegment {
  startSec: number;
  endSec: number;
  /** Fator de enquadramento (1.00 = normal, 1.07 = punch-in sutil em momento de destaque) */
  zoomFactor: number;
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
        : style?.accentColor === 'cyan'
          ? '{\\c&H00FFE66D&}'
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
 * Formata segundos no formato de tempo ASS (H:MM:SS.cc).
 */
export function formatAssTimestamp(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const hrs = Math.floor(totalCs / 360_000);
  const mins = Math.floor((totalCs % 360_000) / 6_000);
  const secs = Math.floor((totalCs % 6_000) / 100);
  const cs = totalCs % 100;
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Gera legendas em formato Advanced SubStation Alpha (.ass) no padrao CapCut Auto Captions:
 * - Blocos curtos com transicoes animadas entre TODAS as legendas (capcut_bounce / pop, capcut_slide_up / fade_slide, capcut_zoom_glow / blur_in)
 * - Auto-destaque na palavra de impacto de cada bloco com cor vibrante + leve pop de escala (sem usar {\r}, preservando \pos e \move!)
 * - Zero sobreposicao temporal entre uma legenda e a seguinte.
 */
export function formatCuesToAnimatedAss(
  cues: readonly SpokenSubtitleCue[],
  style?: EditorSubtitleStyle,
): string {
  if (cues.length === 0) return '';

  const highlightSet = new Set(
    (style?.highlightWords ?? [])
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 2),
  );

  // Cores no formato BGR do ASS (&H00BBGGRR&)
  const baseWhiteAss = '&H00FFFFFF&';
  const accentAssColor =
    style?.accentColor === 'red'
      ? '&H004848FF&'
      : style?.accentColor === 'green'
        ? '&H0066FF00&'
        : style?.accentColor === 'cyan'
          ? '&H00FFFF00&'
          : style?.accentColor === 'white'
            ? '&H0000E6FF&'
            : '&H0000E6FF&'; // Amarelo CapCut (#FFE600)

  const transitionPalette: SubtitleTransitionStyle[] =
    style?.subtitleTransitions && style.subtitleTransitions.length > 0
      ? style.subtitleTransitions
      : ['pop', 'fade_slide', 'blur_in'];

  const escapeAssText = (raw: string): string =>
    raw.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');

  // IMPORTANTE: NUNCA usar {\r} no ASS porque {\r} reseta \pos, \move e \fad da linha inteira no libass!
  // Em vez disso, fechamos o destaque restaurando explicitamente a cor base e a escala 100%.
  const wrapHighlightedWord = (word: string): string =>
    `{\\c${accentAssColor}\\fscx110\\fscy110}${word.toUpperCase()}{\\c${baseWhiteAss}\\fscx100\\fscy100}`;

  const applyCapCutWordEmphasis = (text: string): string => {
    const clean = escapeAssText(text.trim());
    const tokens = clean.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return clean;

    let matchedExplicit = false;
    const styledTokens = tokens.map((tok) => {
      const stripped = tok.replace(/[^a-zA-Z0-9À-ÿ]/g, '').toLowerCase();
      if (stripped.length >= 2 && highlightSet.has(stripped)) {
        matchedExplicit = true;
        return wrapHighlightedWord(tok);
      }
      return tok;
    });

    if (matchedExplicit) {
      return styledTokens.join(' ');
    }

    // Padrao CapCut Dynamic Captions: destaca automaticamente a palavra mais expressiva do bloco (>= 4 letras)
    let bestIdx = -1;
    let bestLen = 0;
    tokens.forEach((tok, idx) => {
      const stripped = tok.replace(/[^a-zA-Z0-9À-ÿ]/g, '');
      if (stripped.length >= 4 && stripped.length > bestLen) {
        bestLen = stripped.length;
        bestIdx = idx;
      }
    });

    if (bestIdx !== -1) {
      tokens[bestIdx] = wrapHighlightedWord(tokens[bestIdx]!);
    }

    return tokens.join(' ');
  };

  const buildTransitionTag = (kind: SubtitleTransitionStyle): string => {
    if (kind === 'fade_slide') {
      // CapCut Slide-Up: entra subindo suavemente + fade-in e fade-out entre legendas
      return '{\\an2\\move(540,1598,540,1562,0,125)\\fad(75,55)}';
    }
    if (kind === 'blur_in') {
      // CapCut Zoom-Glow: entra com leve desfoque + zoom suave
      return '{\\an2\\pos(540,1562)\\blur3.5\\fscx86\\fscy86\\t(0,115,\\blur0\\fscx104\\fscy104)\\t(115,175,\\fscx100\\fscy100)\\fad(70,55)}';
    }
    // CapCut Pop Bounce: entrada elastica classica do CapCut entre cada bloco de legenda
    return '{\\an2\\pos(540,1562)\\fscx78\\fscy78\\t(0,85,\\fscx107\\fscy107)\\t(85,155,\\fscx100\\fscy100)\\fad(55,50)}';
  };

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: WorkOfficeShort,DejaVu Sans,64,&H00FFFFFF,&H0000E6FF,&H000A0A0A,&H78000000,-1,0,0,0,100,100,0.6,0,1,5,3,2,65,65,340,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // Garante zero sobreposicao temporal entre uma legenda e a proxima para que a transicao entre elas seja 100% visivel
  const nonOverlapping = cues.map((cue, idx) => {
    const safeStart = Math.max(0, cue.startSec);
    const nextStart = cues[idx + 1]?.startSec;
    const maxEnd =
      typeof nextStart === 'number' && nextStart > safeStart + 0.14
        ? nextStart - 0.02
        : cue.endSec;
    const safeEnd = Math.max(safeStart + 0.14, Math.min(cue.endSec, maxEnd));
    return { startSec: safeStart, endSec: safeEnd, text: cue.text };
  });

  const dialogues = nonOverlapping.map((cue, idx) => {
    const txKind = transitionPalette[idx % transitionPalette.length]!;
    const styledText = `${buildTransitionTag(txKind)}${applyCapCutWordEmphasis(cue.text)}`;
    return `Dialogue: 0,${formatAssTimestamp(cue.startSec)},${formatAssTimestamp(cue.endSec)},WorkOfficeShort,,0,0,0,,${styledText}`;
  });

  return [...header, ...dialogues, ''].join('\n');
}

/**
 * Parseia os intervalos silenciosos da saida stderr do filtro `silencedetect` do ffmpeg.
 */
export function parseSilenceDetectLog(stderr: string, clipDurationSec: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (startMatch?.[1]) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (endMatch?.[1] && pendingStart !== null) {
      const endSec = Math.min(clipDurationSec, Number(endMatch[1]));
      if (endSec > pendingStart) {
        intervals.push({ startSec: Math.max(0, pendingStart), endSec });
      }
      pendingStart = null;
    }
  }

  if (pendingStart !== null && clipDurationSec > pendingStart) {
    intervals.push({ startSec: Math.max(0, pendingStart), endSec: clipDurationSec });
  }

  return intervals;
}

/**
 * Constroi os segmentos ativos do Short removendo pausas silenciosas >= minSilenceToCutSec,
 * preservando um respiro natural (paddingSec) e inserindo pontos de punch-in zoom sutil (1.07x)
 * nos momentos escolhidos pelo Editor.
 */
export function buildActiveEditSegments(params: {
  clipDurationSec: number;
  silences: readonly SilenceInterval[];
  zoomMomentsSec?: readonly number[];
  minSilenceToCutSec?: number;
  paddingSec?: number;
  maxSegments?: number;
}): ActiveEditSegment[] {
  const totalDur = Math.max(1, params.clipDurationSec);
  const minCut = params.minSilenceToCutSec ?? 0.65;
  const pad = params.paddingSec ?? 0.12;
  const maxSegs = Math.max(2, params.maxSegments ?? 4);

  // Filtra apenas pausas longas o suficiente para remover sem picotar a fala
  const cuttable = params.silences
    .filter((s) => s.endSec - s.startSec >= minCut)
    .map((s) => ({
      startSec: Math.max(0, s.startSec + pad),
      endSec: Math.min(totalDur, s.endSec - pad),
    }))
    .filter((s) => s.endSec - s.startSec >= 0.25)
    .sort((a, b) => a.startSec - b.startSec);

  const kept: { startSec: number; endSec: number }[] = [];
  let cursor = 0;

  for (const sil of cuttable) {
    if (sil.startSec > cursor + 0.35) {
      kept.push({
        startSec: Number(cursor.toFixed(3)),
        endSec: Number(sil.startSec.toFixed(3)),
      });
    }
    cursor = Math.max(cursor, sil.endSec);
  }

  if (totalDur - cursor >= 0.35) {
    kept.push({
      startSec: Number(cursor.toFixed(3)),
      endSec: Number(totalDur.toFixed(3)),
    });
  }

  // Garante pelo menos 1 segmento valido caso o audio inteiro seja muito baixo
  let segments =
    kept.length > 0 && kept.reduce((acc, s) => acc + (s.endSec - s.startSec), 0) >= 2.5
      ? kept
      : [{ startSec: 0, endSec: Number(totalDur.toFixed(3)) }];

  // Se houver momentos especificos de zoom dentro de segmentos longos, divide suavemente para punch-in
  const validZoomPoints = (params.zoomMomentsSec ?? [])
    .filter((t) => Number.isFinite(t) && t >= 2.0 && t <= totalDur - 2.0)
    .sort((a, b) => a - b)
    .slice(0, 3);

  for (const zp of validZoomPoints) {
    if (segments.length >= maxSegs) break;
    const idx = segments.findIndex((s) => zp > s.startSec + 1.8 && zp < s.endSec - 1.8);
    if (idx !== -1) {
      const target = segments[idx]!;
      const splitAt = Number(zp.toFixed(3));
      segments.splice(
        idx,
        1,
        { startSec: target.startSec, endSec: splitAt },
        { startSec: splitAt, endSec: target.endSec },
      );
    }
  }

  // Se ultrapassar maxSegs, une segmentos muito curtos adjacentes para manter o filtro leve
  while (segments.length > maxSegs) {
    let shortestIdx = 0;
    let shortestDur = Infinity;
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = segments[i + 1]!.startSec - segments[i]!.endSec;
      const combined = segments[i]!.endSec - segments[i]!.startSec + gap;
      if (combined < shortestDur) {
        shortestDur = combined;
        shortestIdx = i;
      }
    }
    const merged = {
      startSec: segments[shortestIdx]!.startSec,
      endSec: segments[shortestIdx + 1]!.endSec,
    };
    segments.splice(shortestIdx, 2, merged);
  }

  // Filtra micro-segmentos (< 0.45s) que atrapalhariam o xfade
  segments = segments.filter((s) => s.endSec - s.startSec >= 0.45);
  if (segments.length === 0) {
    segments = [{ startSec: 0, endSec: Number(totalDur.toFixed(3)) }];
  }

  // Atribui punch-in sutil (1.07x) apenas em segmentos de destaque (evitando dois seguidos com zoom)
  let prevZoomed = false;
  return segments.map((seg, idx) => {
    const matchesZoomMoment = validZoomPoints.some(
      (zp) => Math.abs(seg.startSec - zp) <= 1.2 || (zp >= seg.startSec && zp <= seg.endSec),
    );
    const shouldZoom =
      !prevZoomed &&
      idx > 0 &&
      (matchesZoomMoment || (validZoomPoints.length === 0 && idx % 3 === 1));
    prevZoomed = shouldZoom;
    return {
      startSec: seg.startSec,
      endSec: seg.endSec,
      zoomFactor: shouldZoom ? 1.05 : 1.0,
    };
  });
}

/**
 * Remapeia os timestamps das falas reais (SpokenSubtitleCue) para a nova linha do tempo
 * resultante dos cortes de silencio + transicoes xfade entre cortes, preservando sincronia exata.
 */
export function remapCuesToEditSegments(
  cues: readonly SpokenSubtitleCue[],
  segments: readonly ActiveEditSegment[],
  transitionSec: number,
): { cues: SpokenSubtitleCue[]; outputDurationSec: number } {
  if (segments.length === 0) {
    return { cues: [...cues], outputDurationSec: 0 };
  }

  const effectiveTx = segments.length > 1 ? Math.max(0, transitionSec) : 0;
  const segTimeline: {
    srcStart: number;
    srcEnd: number;
    outStart: number;
    outEnd: number;
  }[] = [];

  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const segDur = Math.max(0.1, seg.endSec - seg.startSec);
    const outStart = i === 0 ? 0 : Math.max(0, cursor - effectiveTx);
    const outEnd = outStart + segDur;
    segTimeline.push({
      srcStart: seg.startSec,
      srcEnd: seg.endSec,
      outStart,
      outEnd,
    });
    cursor = outEnd;
  }

  const outputDurationSec = Number(cursor.toFixed(3));
  const remapped: SpokenSubtitleCue[] = [];

  for (const cue of cues) {
    for (const seg of segTimeline) {
      const overlapStart = Math.max(cue.startSec, seg.srcStart);
      const overlapEnd = Math.min(cue.endSec, seg.srcEnd);
      if (overlapEnd - overlapStart >= 0.08) {
        const newStart = Number((seg.outStart + (overlapStart - seg.srcStart)).toFixed(3));
        const newEnd = Number(
          Math.min(outputDurationSec, seg.outStart + (overlapEnd - seg.srcStart)).toFixed(3),
        );
        if (newEnd - newStart >= 0.08) {
          remapped.push({
            startSec: newStart,
            endSec: newEnd,
            text: cue.text,
          });
        }
      }
    }
  }

  return { cues: remapped, outputDurationSec };
}

/**
 * Executa o filtro silencedetect do ffmpeg sobre o trecho baixado para encontrar pausas sem som.
 */
async function detectSilentIntervalsInClip(
  rawClipPath: string,
  clipDurationSec: number,
): Promise<SilenceInterval[]> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        rawClipPath,
        '-af',
        'silencedetect=noise=-32dB:d=0.45',
        '-f',
        'null',
        '-',
      ],
      { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return parseSilenceDetectLog(stderr, clipDurationSec);
  } catch (err) {
    const maybeStderr = (err as { stderr?: string })?.stderr ?? '';
    return maybeStderr ? parseSilenceDetectLog(maybeStderr, clipDurationSec) : [];
  }
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

const YOUTUBE_IOS_USER_AGENT =
  'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

const YOUTUBE_IOS_CLIENT_CONTEXT = {
  clientName: 'IOS',
  clientVersion: '20.10.4',
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.2.22D82',
  hl: 'pt',
  gl: 'BR',
};

interface YoutubeEmbedVisitorSession {
  visitorData?: string;
  cookieHeader: string;
  fetchedAtMs: number;
}

interface CachedResolvedStreams {
  videoUrl: string;
  audioUrl?: string;
  userAgent: string;
  cookieHeader: string;
  defaultLanguage?: string;
  expiresAtMs: number;
}

const embedSessionCacheByVideoId = new Map<string, YoutubeEmbedVisitorSession>();
const resolvedStreamCacheByVideoId = new Map<string, CachedResolvedStreams>();
const languageCacheByVideoId = new Map<string, string>();

/**
 * Inicializa uma sessao valida via `/embed/<videoId>` (que nunca exige login)
 * capturando os cookies de sessao (`VISITOR_INFO1_LIVE`, `YSC`, `PREF`) e o token `VISITOR_DATA`
 * para autenticar chamadas subsequentes ao InnerTube e ao yt-dlp em IPs de datacenter (Railway).
 */
async function fetchYoutubeEmbedVisitorSession(
  videoId: string,
  forceRefresh = false,
): Promise<YoutubeEmbedVisitorSession> {
  const cached = embedSessionCacheByVideoId.get(videoId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAtMs < 25 * 60_000) {
    return cached;
  }

  const baseCookie = 'CONSENT=YES+cb.20210328-17-p0.en+FX+999';
  try {
    const embedRes = await fetch(`https://www.youtube.com/embed/${videoId}?hl=pt&gl=BR`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://www.google.com/',
        Cookie: baseCookie,
      },
      signal: AbortSignal.timeout(8_000),
    });

    const getSetCookieFn = (
      embedRes.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie;
    const rawCookies = typeof getSetCookieFn === 'function' ? getSetCookieFn.call(embedRes.headers) : [];
    const cookiePairs = [
      baseCookie,
      ...rawCookies.map((c) => c.split(';')[0]?.trim()).filter(Boolean),
    ];
    const html = await embedRes.text();
    const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];

    const session: YoutubeEmbedVisitorSession = {
      visitorData,
      cookieHeader: Array.from(new Set(cookiePairs)).join('; '),
      fetchedAtMs: Date.now(),
    };
    embedSessionCacheByVideoId.set(videoId, session);
    return session;
  } catch {
    return {
      cookieHeader: baseCookie,
      fetchedAtMs: Date.now(),
    };
  }
}

/**
 * Detecta o idioma falado ORIGINAL do video no YouTube (ex: "pt", "en", "es")
 * usando o cache de stream ou a sessao `/embed` + InnerTube IOS.
 * Nunca traduz: garante que videos em portugues fiquem em portugues e em ingles fiquem em ingles.
 */
export async function detectYoutubeOriginalLanguage(sourceUrl: string): Promise<string | null> {
  const idMatch = sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch?.[1]) return null;
  const videoId = idMatch[1];

  const cachedLang = languageCacheByVideoId.get(videoId);
  if (cachedLang) return cachedLang;

  try {
    const session = await fetchYoutubeEmbedVisitorSession(videoId);
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YOUTUBE_IOS_USER_AGENT,
        Cookie: session.cookieHeader,
        ...(session.visitorData ? { 'X-Goog-Visitor-Id': session.visitorData } : {}),
      },
      body: JSON.stringify({
        context: {
          client: {
            ...YOUTUBE_IOS_CLIENT_CONTEXT,
            ...(session.visitorData ? { visitorData: session.visitorData } : {}),
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
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
    const normalized = rawLang ? rawLang.split('-')[0]!.toLowerCase() : null;
    if (normalized) {
      languageCacheByVideoId.set(videoId, normalized);
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Monta os argumentos reais do `yt-dlp` para baixar apenas o segmento especifico (start-end)
 * priorizando clientes IOS/MWEB/TV, injetando visitor_data + cookies da sessao /embed e suportando streams DASH.
 */
export function buildYtDlpSegmentArgs(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputTemplatePath: string;
  playerClients?: string;
  visitorData?: string;
  cookieHeader?: string;
}): string[] {
  validateSafeExternalUrl(params.sourceUrl, { enforceAllowedMediaHost: true });
  validateShortClipDuration(params.startSec, params.endSec);

  const clients = params.playerClients ?? 'ios,mweb,tv_embedded,android,web';
  const extractorArg = params.visitorData
    ? `youtube:player_client=${clients};visitor_data=${params.visitorData}`
    : `youtube:player_client=${clients}`;

  const args: string[] = [
    '--no-playlist',
    '--extractor-args',
    extractorArg,
    '--download-sections',
    `*${params.startSec}-${params.endSec}`,
    '-f',
    'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best',
    '--merge-output-format',
    'mp4',
  ];

  if (params.cookieHeader) {
    args.push('--add-header', `Cookie:${params.cookieHeader}`);
  }

  args.push('-o', params.outputTemplatePath, params.sourceUrl);
  return args;
}

async function runFfmpegSliceFromStreamUrls(params: {
  videoUrl: string;
  audioUrl?: string;
  userAgent: string;
  cookieHeader?: string;
  startSec: number;
  clipDuration: number;
  outputPath: string;
}): Promise<boolean> {
  const headerArgs = params.cookieHeader
    ? ['-headers', `Cookie: ${params.cookieHeader}\r\n`]
    : [];

  const ffArgs: string[] = params.audioUrl
    ? [
        '-y',
        '-user_agent',
        params.userAgent,
        ...headerArgs,
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.videoUrl,
        '-user_agent',
        params.userAgent,
        ...headerArgs,
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.audioUrl,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-shortest',
        params.outputPath,
      ]
    : [
        '-y',
        '-user_agent',
        params.userAgent,
        ...headerArgs,
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.videoUrl,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        params.outputPath,
      ];

  await execFileAsync('ffmpeg', ffArgs, { timeout: 65_000 });
  const stat = await fs.stat(params.outputPath).catch(() => null);
  return Boolean(stat && stat.size > 4096);
}

/**
 * Camada 1 Direta (Anti-Bloqueio de Datacenter + Cache de Stream por 40 min):
 * Inicializa sessao de cookies + VISITOR_DATA via `/embed/<videoId>`, consulta InnerTube (`IOS` / `ANDROID_VR` / `MWEB`),
 * faz cache das URLs de stream `googlevideo.com` (validas por 6h) para reutilizar em multiplos cortes do mesmo video
 * sem bater novamente no YouTube, e recorta [startSec, endSec] via `ffmpeg` com PTS=0!
 */
async function tryDownloadSegmentViaInnertubeIosAndFfmpeg(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const idMatch = params.sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch?.[1]) {
    return { ok: false, reason: 'Video ID nao identificado na URL.' };
  }
  const videoId = idMatch[1];
  const clipDuration = validateShortClipDuration(params.startSec, params.endSec);

  // 0. Verifica se ja temos as URLs de stream desse videoId em cache na memoria do worker (evita chamar /player repetidamente!)
  const cachedStream = resolvedStreamCacheByVideoId.get(videoId);
  if (cachedStream && cachedStream.expiresAtMs > Date.now()) {
    try {
      const slicedOk = await runFfmpegSliceFromStreamUrls({
        videoUrl: cachedStream.videoUrl,
        audioUrl: cachedStream.audioUrl,
        userAgent: cachedStream.userAgent,
        cookieHeader: cachedStream.cookieHeader,
        startSec: params.startSec,
        clipDuration,
        outputPath: params.outputPath,
      });
      if (slicedOk) {
        return { ok: true };
      }
    } catch {
      resolvedStreamCacheByVideoId.delete(videoId);
    }
  }

  const clientConfigs = [
    {
      label: 'IOS',
      userAgent: YOUTUBE_IOS_USER_AGENT,
      clientCtx: YOUTUBE_IOS_CLIENT_CONTEXT,
    },
    {
      label: 'ANDROID_VR',
      userAgent:
        'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      clientCtx: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        hl: 'pt',
        gl: 'BR',
      },
    },
  ];

  let lastReason = 'InnerTube nao retornou streams';

  for (let attempt = 0; attempt < clientConfigs.length; attempt++) {
    const cfg = clientConfigs[attempt]!;
    try {
      const session = await fetchYoutubeEmbedVisitorSession(videoId, attempt > 0);
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': cfg.userAgent,
          Cookie: session.cookieHeader,
          ...(session.visitorData ? { 'X-Goog-Visitor-Id': session.visitorData } : {}),
        },
        body: JSON.stringify({
          context: {
            client: {
              ...cfg.clientCtx,
              ...(session.visitorData ? { visitorData: session.visitorData } : {}),
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        lastReason = `InnerTube ${cfg.label} HTTP ${res.status}`;
        continue;
      }

      const data = (await res.json()) as {
        playabilityStatus?: { status?: string; reason?: string };
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: { languageCode?: string; kind?: string }[];
          };
        };
        streamingData?: {
          hlsManifestUrl?: string;
          formats?: {
            url?: string;
            mimeType?: string;
            height?: number;
            bitrate?: number;
          }[];
          adaptiveFormats?: {
            url?: string;
            mimeType?: string;
            height?: number;
            bitrate?: number;
          }[];
        };
      };

      // Aproveita a resposta do /player para guardar o idioma original real em cache (zero request extra em transcribe_audio!)
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      if (tracks.length > 0) {
        const asrTrack = tracks.find((t) => t.kind === 'asr' && t.languageCode);
        const rawLang = asrTrack?.languageCode ?? tracks[0]?.languageCode;
        if (rawLang) {
          languageCacheByVideoId.set(videoId, rawLang.split('-')[0]!.toLowerCase());
        }
      }

      if (data.playabilityStatus?.status !== 'OK') {
        lastReason = `InnerTube ${cfg.label} status=${data.playabilityStatus?.status ?? 'UNKNOWN'} (${data.playabilityStatus?.reason ?? ''})`;
        continue;
      }

      const adaptive = data.streamingData?.adaptiveFormats ?? [];
      const muxed = data.streamingData?.formats ?? [];

      const videoCandidates = adaptive
        .filter((f) => f.url && f.mimeType?.includes('video/mp4') && (f.height ?? 0) <= 1080)
        .sort((a, b) => {
          const aAvc = a.mimeType?.includes('avc1') ? 1 : 0;
          const bAvc = b.mimeType?.includes('avc1') ? 1 : 0;
          if (aAvc !== bAvc) return bAvc - aAvc;
          return (b.height ?? 0) - (a.height ?? 0);
        });

      const audioCandidates = adaptive
        .filter(
          (f) => f.url && (f.mimeType?.includes('audio/mp4') || f.mimeType?.includes('audio/webm')),
        )
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

      const bestVideo = videoCandidates[0];
      const bestAudio = audioCandidates[0];

      if (bestVideo?.url && bestAudio?.url) {
        resolvedStreamCacheByVideoId.set(videoId, {
          videoUrl: bestVideo.url,
          audioUrl: bestAudio.url,
          userAgent: cfg.userAgent,
          cookieHeader: session.cookieHeader,
          expiresAtMs: Date.now() + 40 * 60_000,
        });

        const ok = await runFfmpegSliceFromStreamUrls({
          videoUrl: bestVideo.url,
          audioUrl: bestAudio.url,
          userAgent: cfg.userAgent,
          cookieHeader: session.cookieHeader,
          startSec: params.startSec,
          clipDuration,
          outputPath: params.outputPath,
        });
        if (ok) return { ok: true };
      }

      const muxedOrHlsUrl = muxed.find((f) => f.url)?.url ?? data.streamingData?.hlsManifestUrl;
      if (muxedOrHlsUrl) {
        resolvedStreamCacheByVideoId.set(videoId, {
          videoUrl: muxedOrHlsUrl,
          userAgent: cfg.userAgent,
          cookieHeader: session.cookieHeader,
          expiresAtMs: Date.now() + 40 * 60_000,
        });

        const ok = await runFfmpegSliceFromStreamUrls({
          videoUrl: muxedOrHlsUrl,
          userAgent: cfg.userAgent,
          cookieHeader: session.cookieHeader,
          startSec: params.startSec,
          clipDuration,
          outputPath: params.outputPath,
        });
        if (ok) return { ok: true };
      }
    } catch (err) {
      lastReason = (err as Error).message?.slice(-220) ?? `Erro InnerTube ${cfg.label}`;
    }
  }

  return { ok: false, reason: lastReason };
}

/**
 * Camada de Contingencia via APIs Publicas Piped / Invidious:
 * Caso o IP do Railway sofra rate-limit temporario nas chamadas diretas ao YouTube,
 * busca os streams MP4/M4A/HLS em endpoints publicos abertos de mirror e recorta via ffmpeg.
 */
async function tryDownloadSegmentViaPublicStreamMirrors(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const idMatch = params.sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!idMatch?.[1]) return { ok: false };
  const videoId = idMatch[1];
  const clipDuration = validateShortClipDuration(params.startSec, params.endSec);
  const browserUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const pipedEndpoints = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://pipedapi.adminforge.de/streams/${videoId}`,
    `https://api.piped.private.coffee/streams/${videoId}`,
  ];

  for (const endpoint of pipedEndpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': browserUa, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        hls?: string;
        videoStreams?: { url?: string; format?: string; height?: number; videoOnly?: boolean }[];
        audioStreams?: { url?: string; format?: string; bitrate?: number }[];
      };

      const vStream = (data.videoStreams ?? [])
        .filter((v) => v.url && (v.height ?? 0) <= 1080)
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
      const aStream = (data.audioStreams ?? [])
        .filter((a) => a.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

      if (vStream?.url && aStream?.url) {
        const ok = await runFfmpegSliceFromStreamUrls({
          videoUrl: vStream.url,
          audioUrl: aStream.url,
          userAgent: browserUa,
          startSec: params.startSec,
          clipDuration,
          outputPath: params.outputPath,
        });
        if (ok) return { ok: true };
      }

      if (data.hls) {
        const ok = await runFfmpegSliceFromStreamUrls({
          videoUrl: data.hls,
          userAgent: browserUa,
          startSec: params.startSec,
          clipDuration,
          outputPath: params.outputPath,
        });
        if (ok) return { ok: true };
      }
    } catch {
      continue;
    }
  }

  return { ok: false, reason: 'Mirrors publicos indisponiveis' };
}

function extractMeaningfulYtDlpError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const raw = `${e.stderr ?? ''}\n${e.message ?? ''}`.trim();
  const errorLines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'));
  if (errorLines.length > 0) {
    return errorLines.join(' | ').slice(0, 280);
  }
  return raw.slice(-280);
}

/**
 * Recorta [startSec, endSec] a partir de arquivos locais de video.mp4 e audio.m4a (ou video muxed)
 * com timestamps PTS zerados em t=0.
 */
async function sliceLocalVideoAndAudioStreamsWithFfmpeg(params: {
  localVideoPath: string;
  localAudioPath?: string;
  startSec: number;
  clipDuration: number;
  outputPath: string;
}): Promise<boolean> {
  const args = params.localAudioPath
    ? [
        '-y',
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.localVideoPath,
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.localAudioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        '-shortest',
        params.outputPath,
      ]
    : [
        '-y',
        '-ss',
        String(params.startSec),
        '-t',
        String(params.clipDuration),
        '-i',
        params.localVideoPath,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '44100',
        params.outputPath,
      ];

  await execFileAsync('ffmpeg', args, { timeout: 45_000 });
  const stat = await fs.stat(params.outputPath).catch(() => null);
  return Boolean(stat && stat.size > 4096);
}

/**
 * Camada 0B — Cache Persistente no Supabase Storage (`shorts` bucket em `yt-cache/<videoId>/...`):
 * Permite que qualquer trecho [startSec, endSec] de um video cacheado no Supabase Storage
 * seja recortado localmente no Worker com ZERO chamadas ao YouTube (imune a bloqueio de IP no Railway!).
 */
async function trySliceSegmentFromSupabaseStorageCache(params: {
  videoId: string;
  startSec: number;
  endSec: number;
  outputPath: string;
  cacheDir: string;
  supabaseStorageClient?: SupabaseClient | null;
}): Promise<boolean> {
  const clipDuration = validateShortClipDuration(params.startSec, params.endSec);
  const localFullVideo = path.join(params.cacheDir, `${params.videoId}_video.mp4`);
  const localFullAudio = path.join(params.cacheDir, `${params.videoId}_audio.m4a`);

  // 1. Verifica se o stream completo ja foi baixado do Supabase Storage para o disco local do container
  const existingVideoStat = await fs.stat(localFullVideo).catch(() => null);
  const existingAudioStat = await fs.stat(localFullAudio).catch(() => null);
  if (existingVideoStat && existingVideoStat.size > 16_384) {
    try {
      const ok = await sliceLocalVideoAndAudioStreamsWithFfmpeg({
        localVideoPath: localFullVideo,
        localAudioPath:
          existingAudioStat && existingAudioStat.size > 4096 ? localFullAudio : undefined,
        startSec: params.startSec,
        clipDuration,
        outputPath: params.outputPath,
      });
      if (ok) return true;
    } catch {
      // Continua para verificar Storage
    }
  }

  if (!params.supabaseStorageClient) return false;

  // 2. Verifica se este exato segmento [startSec, endSec] ja esta salvo no bucket 'shorts'
  const remoteSegPath = `yt-cache/${params.videoId}/${params.startSec}_${params.endSec}.mp4`;
  try {
    const { data: segData, error: segErr } = await params.supabaseStorageClient.storage
      .from('shorts')
      .download(remoteSegPath);
    if (!segErr && segData) {
      const buf = Buffer.from(await segData.arrayBuffer());
      if (buf.byteLength > 4096) {
        await fs.writeFile(params.outputPath, buf);
        return true;
      }
    }
  } catch {
    // Segue para verificar streams completos no Storage
  }

  // 3. Verifica se os streams base `yt-cache/<videoId>/video.mp4` + `audio.m4a` estao no bucket 'shorts'
  try {
    const [videoDl, audioDl] = await Promise.all([
      params.supabaseStorageClient.storage
        .from('shorts')
        .download(`yt-cache/${params.videoId}/video.mp4`),
      params.supabaseStorageClient.storage
        .from('shorts')
        .download(`yt-cache/${params.videoId}/audio.m4a`),
    ]);

    if (!videoDl.error && videoDl.data) {
      const vBuf = Buffer.from(await videoDl.data.arrayBuffer());
      if (vBuf.byteLength > 16_384) {
        await fs.mkdir(params.cacheDir, { recursive: true });
        await fs.writeFile(localFullVideo, vBuf);

        let hasAudio = false;
        if (!audioDl.error && audioDl.data) {
          const aBuf = Buffer.from(await audioDl.data.arrayBuffer());
          if (aBuf.byteLength > 4096) {
            await fs.writeFile(localFullAudio, aBuf);
            hasAudio = true;
          }
        }

        const ok = await sliceLocalVideoAndAudioStreamsWithFfmpeg({
          localVideoPath: localFullVideo,
          localAudioPath: hasAudio ? localFullAudio : undefined,
          startSec: params.startSec,
          clipDuration,
          outputPath: params.outputPath,
        });
        if (ok) return true;
      }
    }
  } catch {
    // Segue para download direto
  }

  return false;
}

/**
 * Baixa o trecho real [startSec, endSec] do YouTube em cascata resiliente com cache persistente
 * no disco local (`/tmp/wo-yt-media-cache`) e no Supabase Storage (`shorts` bucket em `yt-cache/<videoId>/...`):
 * 0A) Cache local do container (`/tmp/wo-yt-media-cache/<videoId>_<startSec>_<endSec>.mp4`)
 * 0B) Cache persistente no Supabase Storage (`yt-cache/<videoId>/video.mp4` + `audio.m4a` ou segmento)
 * 1) Stream direto via InnerTube `IOS` + cache de URLs de stream por 40 min
 * 2) yt-dlp (`ios,mweb,tv_embedded` e `android,web`)
 * 3) Fallback via APIs publicas de stream mirror (Piped)
 */
export async function downloadVideoSegmentToFile(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
  supabaseStorageClient?: SupabaseClient | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const isRealYoutubeWatchUrl =
    /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/)[a-zA-Z0-9_-]{11}/.test(
      params.sourceUrl,
    ) || /^https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}/.test(params.sourceUrl);

  if (!isRealYoutubeWatchUrl) {
    return {
      ok: false,
      reason: `URL de origem inválida ou não é um vídeo real do YouTube: ${params.sourceUrl}`,
    };
  }

  const videoId =
    params.sourceUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/)?.[1] ?? 'clip';
  const cacheDir = path.join(os.tmpdir(), 'wo-yt-media-cache');
  const cachedSegmentPath = path.join(
    cacheDir,
    `${videoId}_${params.startSec}_${params.endSec}.mp4`,
  );

  // Camada 0A: Cache em disco do container Railway (se este exato trecho ja foi baixado antes, reutiliza instantaneamente!)
  try {
    const cachedStat = await fs.stat(cachedSegmentPath).catch(() => null);
    if (cachedStat && cachedStat.size > 4096) {
      await fs.copyFile(cachedSegmentPath, params.outputPath);
      return { ok: true };
    }
  } catch {
    // Segue
  }

  // Camada 0B: Cache persistente no Supabase Storage (`yt-cache/<videoId>/video.mp4` + `audio.m4a` ou segmento)
  const fromStorageCache = await trySliceSegmentFromSupabaseStorageCache({
    videoId,
    startSec: params.startSec,
    endSec: params.endSec,
    outputPath: params.outputPath,
    cacheDir,
    supabaseStorageClient: params.supabaseStorageClient,
  });
  if (fromStorageCache) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.copyFile(params.outputPath, cachedSegmentPath);
    } catch {
      // Best-effort
    }
    return { ok: true };
  }

  const saveToDiskAndStorageCache = async () => {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.copyFile(params.outputPath, cachedSegmentPath);
      if (params.supabaseStorageClient) {
        const segBuf = await fs.readFile(params.outputPath);
        await params.supabaseStorageClient.storage
          .from('shorts')
          .upload(`yt-cache/${videoId}/${params.startSec}_${params.endSec}.mp4`, segBuf, {
            contentType: 'video/mp4',
            upsert: true,
          });
      }
    } catch {
      // Cache best-effort
    }
  };

  // Camada 1: InnerTube IOS + cache de stream URLs + ffmpeg Range
  const iosResult = await tryDownloadSegmentViaInnertubeIosAndFfmpeg(params);
  if (iosResult.ok) {
    await saveToDiskAndStorageCache();
    return { ok: true };
  }

  // Camada 2: yt-dlp com perfis de cliente variados
  const clientProfiles = ['ios,mweb,tv_embedded', 'android,web'];
  let lastErrorReason = iosResult.reason ?? 'Erro desconhecido';

  for (const profile of clientProfiles) {
    try {
      await fs.rm(params.outputPath, { force: true }).catch(() => {});
      const ytdlpArgs = buildYtDlpSegmentArgs({
        sourceUrl: params.sourceUrl,
        startSec: params.startSec,
        endSec: params.endSec,
        outputTemplatePath: params.outputPath,
        playerClients: profile,
      });
      await execFileAsync('yt-dlp', ytdlpArgs, { timeout: 75_000 });
      const stat = await fs.stat(params.outputPath).catch(() => null);
      if (stat && stat.size > 4096) {
        const normPath = `${params.outputPath}.norm.mp4`;
        try {
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-fflags',
              '+genpts',
              '-i',
              params.outputPath,
              '-avoid_negative_ts',
              'make_zero',
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '20',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-ar',
              '44100',
              normPath,
            ],
            { timeout: 40_000 },
          );
          const normStat = await fs.stat(normPath).catch(() => null);
          if (normStat && normStat.size > 4096) {
            await fs.rename(normPath, params.outputPath);
          }
        } catch {
          await fs.rm(normPath, { force: true }).catch(() => {});
        }
        await saveToDiskAndStorageCache();
        return { ok: true };
      }
      lastErrorReason = `Arquivo baixado pelo yt-dlp (${profile}) ficou vazio (< 4 KB).`;
    } catch (err) {
      lastErrorReason = extractMeaningfulYtDlpError(err);
    }
  }

  // Camada 3: Fallback via APIs publicas de stream mirror (Piped)
  const mirrorResult = await tryDownloadSegmentViaPublicStreamMirrors(params);
  if (mirrorResult.ok) {
    await saveToDiskAndStorageCache();
    return { ok: true };
  }

  return {
    ok: false,
    reason: `${lastErrorReason} (InnerTube: ${iosResult.reason ?? 'falhou'})`,
  };
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
  contextPrompt?: string;
  workDir: string;
}): Promise<ExtractedSpokenTranscript | null> {
  const wavPath = path.join(params.workDir, 'clip_audio_16k.wav');
  try {
    // Isola a frequencia da voz humana (85Hz-7800Hz) e normaliza o volume antes de enviar ao Whisper,
    // reduzindo drasticamente erros em trechos com musica de fundo ou efeitos sonoros de jogos!
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          params.rawClipPath,
          '-vn',
          '-af',
          'highpass=f=85,lowpass=f=7800,dynaudnorm=p=0.9:s=5',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-f',
          'wav',
          wavPath,
        ],
        { timeout: 30_000 },
      );
    } catch {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', params.rawClipPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
        { timeout: 30_000 },
      );
    }

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

    const pyArgs = [scriptPath, wavPath, params.originalLang ?? 'auto'];
    if (params.contextPrompt) {
      pyArgs.push(params.contextPrompt.slice(0, 240));
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
  contextPrompt?: string;
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

  // Prioridade CapCut Auto-Captions: quando temos o arquivo de audio real do clipe normalizado (PTS=0),
  // priorizamos o faster-whisper word-level direto sobre o audio do clipe para sincronia milimetrica!
  if (params.rawClipPath) {
    const fromWhisper = await tryTranscribeViaLocalFasterWhisper({
      rawClipPath: params.rawClipPath,
      originalLang,
      contextPrompt: params.contextPrompt,
      workDir: params.workDir,
    });
    if (fromWhisper && fromWhisper.cues.length > 0) {
      return fromWhisper;
    }

    // Camada 2: Cloud STT (OpenAI Whisper / Gemini Audio) sobre o mesmo audio do clipe
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

  // Camada 3: Legendas originais via yt-dlp caso o audio local nao esteja disponivel
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

  return {
    language: originalLang ?? 'unknown',
    source: 'none',
    cues: [],
  };
}

/**
 * Constroi o filtro de enquadramento de MEIO-TERMO IDEAL (Balanced 16:9 -> 9:16 Framing):
 * - Nao estica/corta 100% da altura (crop 9:16 puro mostrava apenas 31.6% da largura e cortava 2 pessoas na tela)
 * - Nao encolhe 100% da largura (fit 16:9 puro deixava a altura util com apenas 608px, muito pequena)
 * - Meio-termo ideal (proporcao 6:5 = 1.20:1): preserva ~68% da largura horizontal original (enquadrando perfeitamente
 *   1 ou 2 pessoas lado a lado) e entrega uma area util grande de 1080x900 centralizada no canvas vertical 1080x1920
 *   (com espaco limpo abaixo para as legendas animadas estilo CapCut sem tampar o rosto dos apresentadores).
 */
export function buildBalancedVerticalFramingFilterExpr(zoomFactor = 1.0): string {
  const z = zoomFactor > 1.01 ? Math.min(1.08, zoomFactor) : 1.0;
  const cropExpr =
    z > 1.0
      ? `crop=ih*1.20/${z.toFixed(2)}:ih/${z.toFixed(2)}`
      : 'crop=ih*1.20:ih';
  return `${cropExpr},scale=1080:900:flags=lanczos,pad=1080:1920:0:460:color=0x0b0f19,setsar=1`;
}

/**
 * Monta os argumentos reais de linha de comando do `ffmpeg` para:
 * - Recorte da janela de tempo (<= 60s)
 * - Enquadramento de meio-termo balanceado (1080x900 util dentro do canvas vertical 1080x1920)
 * - Zoom sutil opcional em momentos especificos
 * - Queima (burn-in) opcional de legendas .ass / .srt estilizadas
 */
export function buildFfmpegVerticalShortArgs(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  subtitleSrtPath?: string;
  subtitleAssPath?: string;
  durationSec: number;
  accentColor?: 'yellow' | 'red' | 'white' | 'green' | 'cyan';
  applyDynamicZoom?: boolean;
}): string[] {
  const safeDuration = validateShortClipDuration(0, params.durationSec);
  const filters: string[] = [
    buildBalancedVerticalFramingFilterExpr(params.applyDynamicZoom ? 1.05 : 1.0),
    'eq=contrast=1.04:saturation=1.08:brightness=0.01',
    'unsharp=3:3:0.3',
    'vignette=angle=PI/5',
  ];

  const primaryColour =
    params.accentColor === 'red'
      ? '&H00FFFFFF'
      : params.accentColor === 'white'
        ? '&H00FFFFFF'
        : params.accentColor === 'cyan'
          ? '&H00FFE66D'
          : params.accentColor === 'green'
            ? '&H0080FF80'
            : '&H0000FFFF';

  if (params.subtitleAssPath) {
    const escapedAss = params.subtitleAssPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(`ass='${escapedAss}'`);
  } else if (params.subtitleSrtPath) {
    const escapedSrt = params.subtitleSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(
      `subtitles='${escapedSrt}':force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,PrimaryColour=${primaryColour},OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=65'`,
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
 * Monta o filter_complex de edicao autoral do Agente Editor:
 * - Recorta apenas segmentos ativos (removendo pausas silenciosas)
 * - Aplica enquadramento de meio-termo balanceado (1080x900 util em canvas 1080x1920, ideal para 1 ou 2 pessoas em tela)
 * - Aplica punch-in zoom sutil (1.05x) em momentos especificos de destaque
 * - Aplica transicoes sutis entre cortes (xfade no video + acrossfade no audio)
 * - Aplica assinatura visual discreta (contraste/cor/nitidez/vinheta suave)
 * - Queima legendas .ass com transicoes variadas sincronizadas na linha do tempo pos-cortes
 */
export function buildFfmpegSignatureEditArgs(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  segments: readonly ActiveEditSegment[];
  subtitleAssPath?: string;
  cutTransition?: CutTransitionStyle;
  transitionDurationSec?: number;
}): string[] {
  const segs = params.segments.length > 0 ? params.segments : [{ startSec: 0, endSec: 30, zoomFactor: 1 }];
  const txStyle: CutTransitionStyle = params.cutTransition ?? 'fade';
  const secondaryTx: CutTransitionStyle = txStyle === 'fade' ? 'dissolve' : 'fade';
  const minSegDur = Math.min(...segs.map((s) => Math.max(0.2, s.endSec - s.startSec)));
  const txDur =
    segs.length > 1
      ? Number(Math.min(params.transitionDurationSec ?? 0.14, minSegDur * 0.35).toFixed(3))
      : 0;

  const graphParts: string[] = [];

  segs.forEach((seg, idx) => {
    const framingExpr = buildBalancedVerticalFramingFilterExpr(seg.zoomFactor);
    graphParts.push(
      `[0:v]trim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},setpts=PTS-STARTPTS,${framingExpr},fps=30,format=yuv420p,eq=contrast=1.04:saturation=1.08:brightness=0.01,unsharp=3:3:0.3[v${idx}]`,
    );
    graphParts.push(
      `[0:a]atrim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100[a${idx}]`,
    );
  });

  let currentVideoLabel = 'v0';
  let currentAudioLabel = 'a0';

  if (segs.length > 1 && txDur >= 0.05) {
    let runningDur = segs[0]!.endSec - segs[0]!.startSec;
    for (let i = 1; i < segs.length; i++) {
      const offset = Math.max(0.05, Number((runningDur - txDur).toFixed(3)));
      const nextVideoLabel = i === segs.length - 1 ? 'vseq' : `vx${i}`;
      const nextAudioLabel = i === segs.length - 1 ? 'aseq' : `ax${i}`;
      const chosenTx = i % 2 === 1 ? txStyle : secondaryTx;

      graphParts.push(
        `[${currentVideoLabel}][v${i}]xfade=transition=${chosenTx}:duration=${txDur}:offset=${offset}[${nextVideoLabel}]`,
      );
      graphParts.push(
        `[${currentAudioLabel}][a${i}]acrossfade=d=${txDur}:c1=tri:c2=tri[${nextAudioLabel}]`,
      );

      runningDur = runningDur + (segs[i]!.endSec - segs[i]!.startSec) - txDur;
      currentVideoLabel = nextVideoLabel;
      currentAudioLabel = nextAudioLabel;
    }
  } else if (segs.length > 1) {
    const concatInputs = segs.map((_, i) => `[v${i}][a${i}]`).join('');
    graphParts.push(`${concatInputs}concat=n=${segs.length}:v=1:a=1[vseq][aseq]`);
    currentVideoLabel = 'vseq';
    currentAudioLabel = 'aseq';
  }

  const finalPostFilters: string[] = ['vignette=angle=PI/5'];
  if (params.subtitleAssPath) {
    const escapedAss = params.subtitleAssPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    finalPostFilters.push(`ass='${escapedAss}'`);
  }

  graphParts.push(`[${currentVideoLabel}]${finalPostFilters.join(',')}[vout]`);

  return [
    '-y',
    '-i',
    params.inputVideoPath,
    '-filter_complex',
    graphParts.join(';'),
    '-map',
    '[vout]',
    '-map',
    `[${currentAudioLabel}]`,
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
    '-movflags',
    '+faststart',
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

/**
 * Monta os argumentos reais do `ffmpeg` para capturar um frame JPEG de alta qualidade
 * do Short renderizado para uso como thumbnail no YouTube.
 */
export function buildFfmpegThumbnailCaptureArgs(params: {
  inputVideoPath: string;
  outputThumbnailPath: string;
  captureOffsetSec: number;
}): string[] {
  const safeOffset = Math.max(0, Number(params.captureOffsetSec.toFixed(2)));
  return [
    '-y',
    '-ss',
    String(safeOffset),
    '-i',
    params.inputVideoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    params.outputThumbnailPath,
  ];
}

/**
 * Gera um buffer JPEG minimo valido (1x1 px) para modo Sandbox/testes quando ffmpeg nao estiver ativo.
 */
export function createMinimalValidJpegBuffer(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
    0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xff, 0xc4, 0x00, 0x14,
    0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
  ]);
}

export interface RenderedShortPackage {
  mp4Buffer: Buffer;
  thumbnailBuffer: Buffer;
  srtContent: string;
  assContent: string;
  durationSec: number;
  resolution: '1080x1920';
  storageVideoPath: string;
  storageSubtitlePath: string;
  storageThumbnailPath: string;
  usedNativeFfmpeg: boolean;
  subtitleCuesCount: number;
  silencesCutCount: number;
  editSegmentsCount: number;
  cutTransition: CutTransitionStyle;
}

/**
 * Executa o pipeline completo de edicao autoral de 1 Short:
 * download -> legenda real da fala -> deteccao/corte de pausas silenciosas ->
 * zoom pontual + transicoes sutis entre cortes + legendas ASS com transicoes variadas ->
 * captura thumbnail -> upload Storage.
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
  thumbnailOffsetSec?: number;
  preDownloadedRawClipPath?: string;
  supabaseStorageClient?: SupabaseClient | null;
  allowSyntheticFallback?: boolean;
}): Promise<RenderedShortPackage> {
  validateSafeExternalUrl(params.sourceUrl);
  const rawDurationSec = validateShortClipDuration(params.startSec, params.endSec);
  const vPad = String(params.videoIndex).padStart(2, '0');
  const storageVideoPath = `${params.officeId}/${params.runId}/short_${vPad}_9x16.mp4`;
  const storageSubtitlePath = `${params.officeId}/${params.runId}/short_${vPad}.srt`;
  const storageThumbnailPath = `${params.officeId}/${params.runId}/short_${vPad}_thumb.jpg`;

  // Em producao (allowSyntheticFallback === false), JAMAIS queima hookText/bodyText como legenda!
  // Usa exclusivamente as falas reais transcritas (spokenCues) no idioma original do video.
  const hasRealSpokenCues = Array.isArray(params.spokenCues) && params.spokenCues.length > 0;
  let activeCues: SpokenSubtitleCue[] = hasRealSpokenCues ? [...params.spokenCues!] : [];
  let finalDurationSec = rawDurationSec;
  let silencesCutCount = 0;
  let editSegmentsCount = 1;
  const chosenCutTransition: CutTransitionStyle = params.subtitleStyle?.cutTransition ?? 'fade';
  const transitionDurationSec = 0.14;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `wo-task-${params.taskId.slice(0, 8)}-`));
  const rawClipFile = params.preDownloadedRawClipPath ?? path.join(tmpDir, `raw_${vPad}.mp4`);
  const srtFile = path.join(tmpDir, `short_${vPad}.srt`);
  const assFile = path.join(tmpDir, `short_${vPad}.ass`);
  const outMp4File = path.join(tmpDir, `short_${vPad}_9x16.mp4`);
  const outThumbFile = path.join(tmpDir, `short_${vPad}_thumb.jpg`);

  let srtContent = hasRealSpokenCues
    ? formatCuesToSrt(activeCues, params.subtitleStyle)
    : params.allowSyntheticFallback === false
      ? ''
      : buildDynamicSrtSubtitles(params.hookText, params.bodyText, rawDurationSec);
  let assContent = hasRealSpokenCues
    ? formatCuesToAnimatedAss(activeCues, params.subtitleStyle)
    : '';

  let mp4Buffer: Buffer;
  let thumbnailBuffer: Buffer = createMinimalValidJpegBuffer();
  let usedNativeFfmpeg = false;

  try {
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
          supabaseStorageClient: params.supabaseStorageClient,
        });
        downloadedRealClip = dl.ok;
        ytDlpFailureReason = dl.reason ?? '';
      }

      if (downloadedRealClip) {
        // 1. Detecta pausas sem som e calcula segmentos ativos + pontos de punch-in zoom sutil
        const shouldRemoveSilences = params.subtitleStyle?.removeSilences !== false;
        const detectedSilences = shouldRemoveSilences
          ? await detectSilentIntervalsInClip(rawClipFile, rawDurationSec)
          : [];
        silencesCutCount = detectedSilences.filter((s) => s.endSec - s.startSec >= 0.45).length;

        const editSegments = buildActiveEditSegments({
          clipDurationSec: rawDurationSec,
          silences: detectedSilences,
          zoomMomentsSec: params.subtitleStyle?.zoomMomentsSec,
        });
        editSegmentsCount = editSegments.length;

        // 2. Remapeia as legendas reais para a linha do tempo pos-cortes de silencio + transicoes
        const hasMultiSegments = editSegments.length > 1;
        const remapped = remapCuesToEditSegments(
          activeCues,
          editSegments,
          hasMultiSegments ? transitionDurationSec : 0,
        );
        if (remapped.outputDurationSec >= 2) {
          finalDurationSec = Math.min(60, Number(remapped.outputDurationSec.toFixed(2)));
        }
        if (hasRealSpokenCues && remapped.cues.length > 0) {
          activeCues = remapped.cues;
          srtContent = formatCuesToSrt(activeCues, params.subtitleStyle);
          assContent = formatCuesToAnimatedAss(activeCues, params.subtitleStyle);
        }

        const hasAssToBurn = assContent.trim().length > 0;
        const hasSrtToBurn = srtContent.trim().length > 0;
        if (hasAssToBurn) {
          await fs.writeFile(assFile, assContent, 'utf8');
        }
        if (hasSrtToBurn) {
          await fs.writeFile(srtFile, srtContent, 'utf8');
        }

        // 3. Tenta renderizacao autoral completa (silence jump-cuts + xfade + zoom pontual + ASS animado)
        try {
          const signatureArgs = buildFfmpegSignatureEditArgs({
            inputVideoPath: rawClipFile,
            outputVideoPath: outMp4File,
            segments: editSegments,
            subtitleAssPath: hasAssToBurn ? assFile : undefined,
            cutTransition: chosenCutTransition,
            transitionDurationSec,
          });
          await execFileAsync('ffmpeg', signatureArgs, { timeout: 90_000 });
          mp4Buffer = await fs.readFile(outMp4File);
          usedNativeFfmpeg = true;
        } catch {
          // Fallback 1: corte 9:16 com assinatura visual e legendas ASS/SRT sobre a duracao original
          if (hasRealSpokenCues) {
            activeCues = [...params.spokenCues!];
            srtContent = formatCuesToSrt(activeCues, params.subtitleStyle);
            assContent = formatCuesToAnimatedAss(activeCues, params.subtitleStyle);
            finalDurationSec = rawDurationSec;
            if (assContent.trim().length > 0) {
              await fs.writeFile(assFile, assContent, 'utf8');
            }
            if (srtContent.trim().length > 0) {
              await fs.writeFile(srtFile, srtContent, 'utf8');
            }
          }
          try {
            const ffmpegArgs = buildFfmpegVerticalShortArgs({
              inputVideoPath: rawClipFile,
              outputVideoPath: outMp4File,
              subtitleAssPath: assContent.trim().length > 0 ? assFile : undefined,
              subtitleSrtPath: srtContent.trim().length > 0 ? srtFile : undefined,
              durationSec: rawDurationSec,
              accentColor: params.subtitleStyle?.accentColor,
              applyDynamicZoom: params.subtitleStyle?.applyDynamicZoom,
            });
            await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 60_000 });
            mp4Buffer = await fs.readFile(outMp4File);
            usedNativeFfmpeg = true;
          } catch {
            // Fallback 2: corte 9:16 limpo sem filtro libass
            const fallbackFfmpegArgs = buildFfmpegVerticalShortArgs({
              inputVideoPath: rawClipFile,
              outputVideoPath: outMp4File,
              durationSec: rawDurationSec,
              applyDynamicZoom: params.subtitleStyle?.applyDynamicZoom,
            });
            await execFileAsync('ffmpeg', fallbackFfmpegArgs, { timeout: 60_000 });
            mp4Buffer = await fs.readFile(outMp4File);
            usedNativeFfmpeg = true;
          }
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
          `color=c=0x0f172a:s=1080x1920:d=${Math.min(5, rawDurationSec)}:r=30`,
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
          String(Math.min(5, rawDurationSec)),
          outMp4File,
        ]);
        mp4Buffer = await fs.readFile(outMp4File);
        usedNativeFfmpeg = true;
      }

      // Captura um frame JPEG de alta qualidade do proprio video 9:16 renderizado para thumbnail no YouTube
      const preferredOffset =
        typeof params.thumbnailOffsetSec === 'number' &&
        params.thumbnailOffsetSec >= 0.5 &&
        params.thumbnailOffsetSec < finalDurationSec - 0.5
          ? params.thumbnailOffsetSec
          : Math.min(Math.max(1, finalDurationSec * 0.3), Math.max(0.5, finalDurationSec - 0.5));

      const captureThumb = async (offsetSec: number): Promise<Buffer | null> => {
        try {
          await execFileAsync(
            'ffmpeg',
            buildFfmpegThumbnailCaptureArgs({
              inputVideoPath: outMp4File,
              outputThumbnailPath: outThumbFile,
              captureOffsetSec: offsetSec,
            }),
            { timeout: 20_000 },
          );
          const buf = await fs.readFile(outThumbFile);
          return buf.byteLength > 512 ? buf : null;
        } catch {
          return null;
        }
      };

      const captured = (await captureThumb(preferredOffset)) ?? (await captureThumb(0.5));
      if (captured) {
        thumbnailBuffer = captured;
      }
    } else {
      mp4Buffer = createMinimalValidMp4Buffer(`${storageVideoPath} (${rawDurationSec}s)`);
    }

    if (params.supabaseStorageClient) {
      await params.supabaseStorageClient.storage
        .from('shorts')
        .upload(storageVideoPath, mp4Buffer, {
          contentType: 'video/mp4',
          upsert: true,
        });

      await params.supabaseStorageClient.storage
        .from('shorts')
        .upload(storageThumbnailPath, thumbnailBuffer, {
          contentType: 'image/jpeg',
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
    thumbnailBuffer,
    srtContent,
    assContent,
    durationSec: finalDurationSec,
    resolution: '1080x1920',
    storageVideoPath,
    storageSubtitlePath,
    storageThumbnailPath,
    usedNativeFfmpeg,
    subtitleCuesCount: hasRealSpokenCues ? activeCues.length : 0,
    silencesCutCount,
    editSegmentsCount,
    cutTransition: chosenCutTransition,
  };
}
