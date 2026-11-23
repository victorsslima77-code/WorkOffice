import { SUPABASE_TARGET_PROJECT_REF } from '@workoffice/shared';
import {
  createWorkerSupabaseClient,
  pollAndDrainQueueBatch,
  recordWorkerHeartbeat,
  SupabaseWorkerRepository,
} from './supabase-repository.js';

export async function startWorkerDaemon() {
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    `https://${SUPABASE_TARGET_PROJECT_REF}.supabase.co`;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
  const pollIntervalMs = Math.max(1000, Number(process.env.WORKER_POLL_INTERVAL_MS || 2000));

  if (!serviceRoleKey) {
    console.warn(
      '[WorkOffice Worker] SUPABASE_SERVICE_ROLE_KEY ausente. Defina a variavel para consumir a fila pgmq em producao.',
    );
    return;
  }

  const supabase = createWorkerSupabaseClient(supabaseUrl, serviceRoleKey);
  const repo = new SupabaseWorkerRepository(supabase);

  let totalProcessed = 0;
  let activeCount = 0;

  console.log(`[WorkOffice Worker] Iniciado (${workerId}) conectado a ${supabaseUrl}`);

  while (true) {
    try {
      await recordWorkerHeartbeat(supabase, workerId, activeCount, totalProcessed);
      activeCount = 1;
      const count = await pollAndDrainQueueBatch(supabase, repo, 3);
      if (count > 0) {
        console.log(`[WorkOffice Worker] Processadas ${count} task(s) da fila pgmq.`);
      }
      totalProcessed += count;
      activeCount = 0;
      await recordWorkerHeartbeat(supabase, workerId, activeCount, totalProcessed);
    } catch (err) {
      activeCount = 0;
      console.error('[WorkOffice Worker] Erro no loop principal:', (err as Error).message);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

void startWorkerDaemon();
