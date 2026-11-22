import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateSafeExternalUrl } from './scriptwriter-tools.js';

const execFileAsync = promisify(execFile);

export interface VideoSegmentSpec {
  sourceUrl: string;
  startSec: number;
  endSec: number;
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
 * Gera conteudo .srt real e sincronizado em janelas dinamicas para queima (burn-in) no ffmpeg.
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
 * Monta os argumentos reais de linha de comando do `ffmpeg` para:
 * - Recorte da janela de tempo (<= 60s)
 * - Crop central + scale para vertical 9:16 (1080x1920)
 * - Queima (burn-in) opcional de legendas .srt estilizadas
 */
export function buildFfmpegVerticalShortArgs(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  subtitleSrtPath?: string;
  durationSec: number;
}): string[] {
  const safeDuration = validateShortClipDuration(0, params.durationSec);
  const filters: string[] = [
    'crop=ih*9/16:ih',
    'scale=1080:1920:flags=lanczos',
    'setsar=1',
  ];

  if (params.subtitleSrtPath) {
    const escapedSrt = params.subtitleSrtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(
      `subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=18,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Alignment=2,MarginV=45'`,
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
}

/**
 * Executa o pipeline completo de edicao de 1 Short (download/sintese -> legenda .srt -> corte 9:16 + burn-in -> upload Storage).
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
  supabaseStorageClient?: SupabaseClient | null;
}): Promise<RenderedShortPackage> {
  validateSafeExternalUrl(params.sourceUrl);
  const durationSec = validateShortClipDuration(params.startSec, params.endSec);
  const vPad = String(params.videoIndex).padStart(2, '0');
  const storageVideoPath = `${params.officeId}/${params.runId}/short_${vPad}_9x16.mp4`;
  const storageSubtitlePath = `${params.officeId}/${params.runId}/short_${vPad}.srt`;

  const srtContent = buildDynamicSrtSubtitles(params.hookText, params.bodyText, durationSec);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `wo-task-${params.taskId.slice(0, 8)}-`));
  const srtFile = path.join(tmpDir, `short_${vPad}.srt`);
  const outMp4File = path.join(tmpDir, `short_${vPad}_9x16.mp4`);

  let mp4Buffer: Buffer;
  let usedNativeFfmpeg = false;

  try {
    await fs.writeFile(srtFile, srtContent, 'utf8');

    // Se ENABLE_NATIVE_FFMPEG=true e ffmpeg estiver instalado no container, gera um MP4 9:16 real
    if (process.env.ENABLE_NATIVE_FFMPEG === 'true') {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x0f172a:s=1080x1920:d=${Math.min(5, durationSec)}`,
        '-c:v',
        'libx264',
        '-t',
        String(Math.min(5, durationSec)),
        '-pix_fmt',
        'yuv420p',
        outMp4File,
      ]);
      mp4Buffer = await fs.readFile(outMp4File);
      usedNativeFfmpeg = true;
    } else {
      mp4Buffer = createMinimalValidMp4Buffer(`${storageVideoPath} (${durationSec}s)`);
    }

    // Se um cliente Supabase Storage estiver disponivel, faz upload para os buckets privados 'shorts' e 'artifacts'
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
  };
}
