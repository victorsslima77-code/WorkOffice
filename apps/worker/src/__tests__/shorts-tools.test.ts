import { describe, expect, it } from 'vitest';
import {
  buildDynamicSrtSubtitles,
  buildFfmpegVerticalShortArgs,
  buildYtDlpSegmentArgs,
  ExternalUrlValidationError,
  extractBestTranscriptWindowForShort,
  fetchShortAnalyticsSnapshot,
  formatCuesToSrt,
  formatSrtTimestamp,
  parseSubtitleTextToCues,
  renderShortVideoPackage,
  uploadShortToYoutubeChannel,
  validateSafeExternalUrl,
} from '../index.js';

describe('@workoffice/worker — Etapa 6 (Tools Reais de Pesquisa, Edicao 9:16/SRT e YouTube OAuth/Analytics)', () => {
  it('protege contra SSRF bloqueando localhost e IPs privados nas tools de video/pesquisa', () => {
    expect(() => validateSafeExternalUrl('http://localhost:8080/secret')).toThrow(
      ExternalUrlValidationError,
    );
    expect(() => validateSafeExternalUrl('http://127.0.0.1:5432/db')).toThrow(
      ExternalUrlValidationError,
    );
    expect(() => validateSafeExternalUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      ExternalUrlValidationError,
    );
    expect(() => validateSafeExternalUrl('file:///etc/passwd')).toThrow(
      ExternalUrlValidationError,
    );

    const valid = validateSafeExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(valid.hostname).toBe('www.youtube.com');
  });

  it('extrai janela de transcricao <= 60s e gera legendas SRT sincronizadas e argumentos ffmpeg 9:16', async () => {
    const window = await extractBestTranscriptWindowForShort(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'Novo Console Portátil',
      1,
    );
    expect(window.endSec - window.startSec).toBeLessThanOrEqual(60);
    expect(window.retentionScore).toBeGreaterThanOrEqual(80);

    expect(formatSrtTimestamp(65.5)).toBe('00:01:05,500');
    const srt = buildDynamicSrtSubtitles(window.hook, window.transcriptText, 52);
    expect(srt).toContain('00:00:00,000 -->');
    expect(srt).toContain(window.hook);

    const ytdlpArgs = buildYtDlpSegmentArgs({
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      startSec: 120,
      endSec: 172,
      outputTemplatePath: '/tmp/clip.mp4',
    });
    expect(ytdlpArgs).toContain('--download-sections');
    expect(ytdlpArgs).toContain('*120-172');

    const ffmpegArgs = buildFfmpegVerticalShortArgs({
      inputVideoPath: '/tmp/in.mp4',
      outputVideoPath: '/tmp/out_9x16.mp4',
      subtitleSrtPath: '/tmp/subs.srt',
      durationSec: 52,
    });
    expect(ffmpegArgs.join(' ')).toContain('scale=1080:1920');
    expect(ffmpegArgs.join(' ')).toContain('subtitles=');
  });

  it('renderiza pacote MP4 vertical + SRT, faz upload para canal de testes OAuth e coleta metricas iniciais', async () => {
    const pkg = await renderShortVideoPackage({
      officeId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      taskId: '33333333-3333-3333-3333-333333333333',
      videoIndex: 1,
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      startSec: 60,
      endSec: 112,
      hookText: 'Gancho teste',
      bodyText: 'Corpo do video com legendas.',
    });

    expect(pkg.resolution).toBe('1080x1920');
    expect(pkg.durationSec).toBe(52);
    expect(pkg.mp4Buffer.byteLength).toBeGreaterThan(24);
    expect(pkg.storageVideoPath).toContain('short_01_9x16.mp4');

    const uploaded = await uploadShortToYoutubeChannel({
      officeId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      videoIndex: 1,
      title: 'Vídeo #1 — Novo Console',
      description: 'Short gerado pelo WorkOffice',
      visibility: 'private',
      mp4Buffer: pkg.mp4Buffer,
      oauth: {
        channelId: 'UC_test_channel',
        refreshToken: 'wo_test_youtube_refresh_123456',
      },
    });
    expect(uploaded.title).toContain('#shorts');
    expect(uploaded.visibility).toBe('private');
    expect(uploaded.publicationStatus).toBe('published');
    expect(uploaded.outputSummary).toContain(uploaded.url);

    // Quando o lote produz mais videos do que a cota diaria (> 6 videos/dia), o Publicador agenda a publicacao
    const scheduledExcess = await uploadShortToYoutubeChannel({
      officeId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      videoIndex: 8,
      title: 'Vídeo #8 — Excedente da Cota Diária',
      description: 'Short agendado automaticamente pelo WorkOffice',
      visibility: 'private',
      mp4Buffer: pkg.mp4Buffer,
    });
    expect(scheduledExcess.publicationStatus).toBe('scheduled');
    expect(scheduledExcess.scheduleDetails?.is_scheduled_due_to_quota).toBe(true);
    expect(scheduledExcess.scheduleDetails?.day_offset).toBe(1);
    expect(scheduledExcess.scheduleDetails?.slot_in_day).toBe(2);
    expect(scheduledExcess.outputSummary).toContain('Agendamento Programado:');

    const metrics = await fetchShortAnalyticsSnapshot({
      youtubeVideoId: uploaded.youtubeVideoId,
      videoIndex: 1,
    });
    expect(metrics.views).toBeGreaterThan(0);
    expect(metrics.retention).toBeGreaterThan(80);
  });

  it('extrai legendas da fala real preservando o idioma original e nunca queima instrucoes do roteirista em producao', async () => {
    const sampleEnglishVtt = `WEBVTT

00:00:08.000 --> 00:00:10.000
Outside clip before start

00:00:12.000 --> 00:00:15.500
I played <00:00:13.000><c>100 hours</c> of GTA 6

00:00:15.600 --> 00:00:19.000
and this moment was insane!

00:01:05.000 --> 00:01:08.000
Outside clip after end
`;

    const cues = parseSubtitleTextToCues(sampleEnglishVtt, 10, 55);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues[0]!.startSec).toBe(2);
    expect(cues.map((c) => c.text).join(' ')).toContain('100 hours');
    expect(cues.map((c) => c.text).join(' ')).not.toContain('Outside clip');

    const styledSrt = formatCuesToSrt(cues, {
      accentColor: 'red',
      highlightWords: ['100 hours', 'insane'],
    });
    expect(styledSrt).toContain('100 HOURS');
    expect(styledSrt).toContain('INSANE');
    expect(styledSrt).toContain('{\\c&H0000FF&}');

    // Em producao (allowSyntheticFallback: false), se nao houver falas detectadas,
    // JAMAIS coloca instrucoes do roteirista (hookText/bodyText) dentro do arquivo .srt
    const noSpeechPkg = await renderShortVideoPackage({
      officeId: '11111111-1111-1111-1111-111111111111',
      runId: '22222222-2222-2222-2222-222222222222',
      taskId: '33333333-3333-3333-3333-333333333333',
      videoIndex: 1,
      sourceUrl: 'https://www.youtube.com/watch?v=ymCHX_Dcc-U',
      startSec: 0,
      endSec: 45,
      hookText: 'Gancho interno do roteirista',
      bodyText: 'Abra com zoom rapido no rosto e destaque em vermelho',
      spokenCues: [],
      allowSyntheticFallback: false,
    });
    expect(noSpeechPkg.srtContent).toBe('');
    expect(noSpeechPkg.srtContent).not.toContain('Abra com zoom');
  });
});
