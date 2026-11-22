-- ==============================================================================
-- Etapa 9.1: Periodicidade Maxima do Publicador (Cota Diaria YouTube Data API v3 = 6/dia)
-- e Agendamento Automatico de Videos Excedentes com URL ou Detalhe do Agendamento
-- Projeto Supabase alvo: jphdogyddahozpcgktdz
-- ==============================================================================

-- 1. Atualiza o escopo, system_prompt e output_schema do cargo publisher_analyst
update public.roles
set
  scope = 'Pegar 1 video pronto por vez na sua estante (shelf_3), manter a periodicidade maxima de publicacao respeitando a cota diaria da YouTube Data API v3 (10.000 un./dia = max. 6 videos publicados/dia, espacados a cada 4h), publicar imediatamente ate o 6o video do dia ou agendar automaticamente os excedentes, emitindo a URL do Short publicado ou o detalhe do agendamento.',
  system_prompt = 'Voce e o Publicador e Analista de Shorts do WorkOffice. Respeite rigorosamente a periodicidade maxima de publicacao e a cota diaria da YouTube Data API v3 (10.000 unidades/dia, 1.600 unidades por upload = maximo de 6 videos publicados por dia, 1 a cada 4 horas). Para videos dentro da cota diaria (1 a 6), publique o Short e retorne a URL publicada. Se produzirem mais videos do que a cota diaria (7 em diante), agende automaticamente a publicacao para as proximas janelas diarias e retorne o detalhe completo do agendamento (schedule_details).',
  output_schema = '{
    "type": "object",
    "required": ["published_videos"],
    "properties": {
      "published_videos": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": ["youtube_video_id", "url", "title", "visibility", "publication_status", "scheduled_at", "output_summary"],
          "properties": {
            "youtube_video_id": { "type": "string" },
            "url": { "type": "string", "format": "uri" },
            "title": { "type": "string" },
            "visibility": { "type": "string", "enum": ["private", "unlisted", "public"] },
            "publication_status": { "type": "string", "enum": ["published", "scheduled"] },
            "scheduled_at": { "type": "string" },
            "quota_units_consumed": { "type": "integer" },
            "daily_quota_limit_videos": { "type": "integer" },
            "schedule_details": { "type": ["object", "null"] },
            "output_summary": { "type": "string" }
          }
        }
      }
    }
  }'::jsonb
where slug = 'publisher_analyst';

-- 2. Atualiza advance_office_run_step para aplicar a regra de cota diaria (6 videos/dia)
-- e agendamento automatico no Publicador (retornando a URL do Short publicado ou o detalhe do agendamento)
create or replace function public.advance_office_run_step(
  p_office_id uuid,
  p_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_run public.runs%rowtype;
  v_task record;
  v_next_agent record;
  v_video_idx integer;
  v_total_videos integer;
  v_instruction text;
  v_vpad text;
  v_in_tokens integer;
  v_out_tokens integer;
  v_reason_tokens integer;
  v_cost_usd numeric(12, 6);
  v_output jsonb;
  v_artifact_kind text;
  v_artifact_title text;
  v_storage_path text;
  v_artifact_id uuid;
  v_next_role_slug text;
  v_new_task_id uuid;
  v_processed_count integer := 0;
  v_remaining_tasks integer := 0;
  v_day_offset integer;
  v_slot_in_day integer;
  v_scheduled_ts timestamptz;
  v_scheduled_formatted text;
  v_short_url text;
  v_is_within_daily_quota boolean;
begin
  if auth.uid() is not null and not public.user_owns_office(p_office_id) then
    raise exception 'Sem permissao neste escritorio.' using errcode = '42501';
  end if;

  select *
  into v_run
  from public.runs
  where office_id = p_office_id
    and (p_run_id is null or id = p_run_id)
    and status in ('queued', 'running')
  order by created_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'processed_tasks', 0,
      'run_status', 'idle',
      'has_more', false
    );
  end if;

  for v_task in
    select
      t.id as task_id,
      t.run_id,
      t.agent_id,
      t.role_id,
      t.input,
      t.attempts,
      a.name as agent_name,
      a.provider,
      a.model,
      a.effort,
      a.desk_slot,
      a.monthly_token_budget,
      r.slug as role_slug
    from public.tasks t
    join public.agents a on a.id = t.agent_id
    join public.roles r on r.id = t.role_id
    where t.run_id = v_run.id
      and t.status = 'queued'
    order by t.created_at asc
    limit 3
  loop
    v_processed_count := v_processed_count + 1;
    v_video_idx := coalesce((v_task.input ->> 'video_index')::integer, 1);
    v_total_videos := coalesce((v_task.input ->> 'total_videos')::integer, 1);
    v_instruction := coalesce(v_task.input ->> 'instruction', 'Crie vídeos para o canal');
    v_vpad := lpad(v_video_idx::text, 2, '0');

    update public.tasks
    set
      status = 'running',
      attempts = v_task.attempts + 1,
      started_at = now()
    where id = v_task.task_id;

    update public.agents
    set status = 'working'
    where id = v_task.agent_id;

    if v_task.role_slug <> 'scriptwriter' or v_video_idx = 1 then
      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'handoff.received',
        jsonb_build_object(
          'message', format('%s pegou o input do Vídeo #%s/%s na sua estante (%s).', v_task.agent_name, v_video_idx, v_total_videos, v_task.desk_slot),
          'videoNumber', v_video_idx,
          'totalVideos', v_total_videos
        )
      );
    end if;

    if v_task.role_slug = 'scriptwriter' then
      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'research.web_search',
        jsonb_build_object(
          'message', format('%s está pesquisando e redigindo instruções de edição do Vídeo #%s/%s ("%s").', v_task.agent_name, v_video_idx, v_total_videos, v_instruction),
          'progress', round((v_video_idx::numeric / greatest(1, v_total_videos)) * 100),
          'videoNumber', v_video_idx,
          'totalVideos', v_total_videos
        )
      );

      v_output := jsonb_build_object(
        'clips', jsonb_build_array(
          jsonb_build_object(
            'source_url', format('https://www.youtube.com/watch?v=source_%s', v_vpad),
            'start_sec', 60 + v_video_idx * 15,
            'end_sec', 112 + v_video_idx * 15,
            'hook', format('Gancho de alta retenção para o Vídeo #%s: %s', v_video_idx, v_instruction),
            'suggested_title', format('Vídeo #%s/%s — %s #shorts', v_video_idx, v_total_videos, left(v_instruction, 55)),
            'rationale', format('Instruções claras de edição do Vídeo #%s/%s sobre "%s".', v_video_idx, v_total_videos, v_instruction),
            'score', least(99, 90 + (v_video_idx % 9))
          )
        )
      );
      v_artifact_kind := 'research_brief';
      v_artifact_title := format('instrucao_edicao_video_%s.json', v_vpad);
      v_storage_path := format('%s/%s/%s', p_office_id, v_run.id, v_artifact_title);
      v_next_role_slug := 'video_editor';

    elsif v_task.role_slug = 'video_editor' then
      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'edit.cut',
        jsonb_build_object(
          'message', format('%s está cortando em 9:16 vertical e queimando legendas do Vídeo #%s/%s.', v_task.agent_name, v_video_idx, v_total_videos),
          'progress', round((v_video_idx::numeric / greatest(1, v_total_videos)) * 100),
          'videoNumber', v_video_idx,
          'totalVideos', v_total_videos
        )
      );

      v_artifact_title := format('video_short_%s_9x16.mp4', v_vpad);
      v_storage_path := format('%s/%s/short_%s_9x16.mp4', p_office_id, v_run.id, v_vpad);
      v_output := jsonb_build_object(
        'edited_shorts', jsonb_build_array(
          jsonb_build_object(
            'storage_path', v_storage_path,
            'subtitle_path', format('%s/%s/short_%s.srt', p_office_id, v_run.id, v_vpad),
            'duration_sec', 52,
            'resolution', '1080x1920',
            'suggested_title', format('Vídeo #%s/%s — %s #shorts', v_video_idx, v_total_videos, left(v_instruction, 55))
          )
        )
      );
      v_artifact_kind := 'edited_short';
      v_next_role_slug := 'publisher_analyst';

    else
      -- Publicador / Analista: Verifica cota diaria da YouTube Data API v3 (10.000 un/dia = max 6 videos/dia, 1 a cada 4h)
      v_day_offset := (v_video_idx - 1) / 6;
      v_slot_in_day := ((v_video_idx - 1) % 6) + 1;
      v_is_within_daily_quota := (v_day_offset = 0);
      v_scheduled_ts := now() + make_interval(hours => (v_day_offset * 24) + ((v_slot_in_day - 1) * 4));
      v_scheduled_formatted := to_char(v_scheduled_ts at time zone 'UTC', 'DD/MM/YYYY "às" HH24:MI "UTC"');
      v_short_url := format('https://youtube.com/shorts/yt_%s_%s', left(v_run.id::text, 6), v_vpad);

      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'publish.upload',
        jsonb_build_object(
          'message', case
            when v_is_within_daily_quota then
              format('%s publicou o Vídeo #%s/%s dentro da cota diária (%s/6 vídeos • %s/10.000 un.): %s', v_task.agent_name, v_video_idx, v_total_videos, v_slot_in_day, v_slot_in_day * 1600, v_short_url)
            else
              format('Cota diária atingida (6/6 vídeos • 9.600/10.000 un.)! %s agendou o Vídeo #%s/%s para %s (Dia +%s • Slot %s/6 • intervalo 4h).', v_task.agent_name, v_video_idx, v_total_videos, v_scheduled_formatted, v_day_offset, v_slot_in_day)
          end,
          'progress', round((v_video_idx::numeric / greatest(1, v_total_videos)) * 100),
          'videoNumber', v_video_idx,
          'totalVideos', v_total_videos
        )
      );

      v_artifact_title := case
        when v_is_within_daily_quota then format('short_%s_publicado_url.json', v_vpad)
        else format('short_%s_agendamento.json', v_vpad)
      end;
      v_storage_path := format('%s/%s/%s', p_office_id, v_run.id, v_artifact_title);

      v_output := jsonb_build_object(
        'published_videos', jsonb_build_array(
          jsonb_build_object(
            'youtube_video_id', format('yt_%s_%s', left(v_run.id::text, 6), v_vpad),
            'url', v_short_url,
            'title', format('Vídeo #%s/%s — %s #shorts', v_video_idx, v_total_videos, left(v_instruction, 55)),
            'visibility', 'private',
            'publication_status', case when v_is_within_daily_quota then 'published' else 'scheduled' end,
            'scheduled_at', v_scheduled_ts,
            'quota_units_consumed', 1600,
            'daily_quota_limit_videos', 6,
            'schedule_details', case
              when v_is_within_daily_quota then null
              else jsonb_build_object(
                'is_scheduled_due_to_quota', true,
                'day_offset', v_day_offset,
                'slot_in_day', v_slot_in_day,
                'daily_quota_limit_videos', 6,
                'interval_hours', 4,
                'scheduled_for_iso', v_scheduled_ts,
                'scheduled_for_formatted', v_scheduled_formatted,
                'quota_units_reserved', 1600,
                'reason', 'Cota diária da YouTube Data API v3 atingida (6/6 vídeos • 9.600/10.000 un.). Agendado automaticamente mantendo a periodicidade máxima de 4h.'
              )
            end,
            'output_summary', case
              when v_is_within_daily_quota then format('URL do Short Publicado: %s (Cota diária %s/6)', v_short_url, v_slot_in_day)
              else format('Agendamento Programado: %s (Dia +%s • Slot %s/6 • intervalo 4h)', v_scheduled_formatted, v_day_offset, v_slot_in_day)
            end
          )
        )
      );
      v_artifact_kind := 'publish_report';
      v_next_role_slug := null;
    end if;

    if v_task.effort = 'high' then
      v_in_tokens := 3200;
      v_out_tokens := 1800;
      v_reason_tokens := 4096;
      v_cost_usd := 0.012400;
    elsif v_task.effort = 'medium' then
      v_in_tokens := 1800;
      v_out_tokens := 950;
      v_reason_tokens := 1024;
      v_cost_usd := 0.004200;
    else
      v_in_tokens := 950;
      v_out_tokens := 520;
      v_reason_tokens := 0;
      v_cost_usd := 0.001150;
    end if;

    insert into public.llm_calls (
      task_id,
      agent_id,
      provider,
      model,
      effort,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cost_usd,
      latency_ms
    )
    values (
      v_task.task_id,
      v_task.agent_id,
      v_task.provider,
      v_task.model,
      v_task.effort,
      v_in_tokens,
      v_out_tokens,
      v_reason_tokens,
      v_cost_usd,
      820 + (v_video_idx * 45)
    );

    insert into public.artifacts (
      run_id,
      task_id,
      kind,
      storage_path,
      metadata
    )
    values (
      v_run.id,
      v_task.task_id,
      v_artifact_kind,
      v_storage_path,
      jsonb_build_object(
        'title', v_artifact_title,
        'video_index', v_video_idx,
        'total_videos', v_total_videos,
        'instruction', v_instruction,
        'agent_id', v_task.agent_id,
        'role_slug', v_task.role_slug,
        'publication_status', case
          when v_artifact_kind = 'publish_report' then
            case when v_is_within_daily_quota then 'published' else 'scheduled' end
          else null
        end,
        'short_url', case when v_artifact_kind = 'publish_report' then v_short_url else null end,
        'output', v_output
      )
    )
    returning id into v_artifact_id;

    if v_artifact_kind = 'publish_report' then
      insert into public.video_metrics (
        artifact_id,
        youtube_video_id,
        views,
        likes,
        comments,
        retention
      )
      values (
        v_artifact_id,
        format('yt_%s_%s', left(v_run.id::text, 6), v_vpad),
        case when v_is_within_daily_quota then 1350 + (v_video_idx * 290) else 0 end,
        case when v_is_within_daily_quota then 165 + (v_video_idx * 34) else 0 end,
        case when v_is_within_daily_quota then 22 + (v_video_idx * 5) else 0 end,
        case when v_is_within_daily_quota then 91.40 else 0 end
      );
    end if;

    update public.tasks
    set
      status = 'completed',
      output = v_output,
      finished_at = now()
    where id = v_task.task_id;

    update public.runs
    set
      total_tokens = total_tokens + v_in_tokens + v_out_tokens + v_reason_tokens,
      total_cost_usd = total_cost_usd + v_cost_usd
    where id = v_run.id;

    if v_next_role_slug is not null then
      select a.id, a.name, a.role_id, a.desk_slot
      into v_next_agent
      from public.agents a
      join public.roles r on r.id = a.role_id
      where a.office_id = p_office_id
        and r.slug = v_next_role_slug
      limit 1;

      if found then
        insert into public.agent_events (office_id, agent_id, task_id, type, payload)
        values (
          p_office_id,
          v_task.agent_id,
          v_task.task_id,
          'handoff.sent',
          jsonb_build_object(
            'message', format('%s saiu da sua sala e deixou o Vídeo #%s/%s na estante de %s (%s).', v_task.agent_name, v_video_idx, v_total_videos, v_next_agent.name, v_next_agent.desk_slot),
            'targetDeskSlot', v_next_agent.desk_slot,
            'videoNumber', v_video_idx,
            'totalVideos', v_total_videos
          )
        );

        insert into public.tasks (run_id, agent_id, role_id, input, status)
        values (
          v_run.id,
          v_next_agent.id,
          v_next_agent.role_id,
          jsonb_build_object(
            'instruction', v_instruction,
            'video_index', v_video_idx,
            'total_videos', v_total_videos,
            'upstream_output', v_output
          ),
          'queued'
        )
        returning id into v_new_task_id;

        perform public.enqueue_agent_task(
          v_new_task_id,
          v_run.id,
          p_office_id,
          v_next_agent.id,
          v_next_role_slug,
          0
        );
      end if;
    end if;

    if v_task.role_slug = 'scriptwriter' and v_video_idx < v_total_videos then
      insert into public.tasks (run_id, agent_id, role_id, input, status)
      values (
        v_run.id,
        v_task.agent_id,
        v_task.role_id,
        jsonb_build_object(
          'instruction', v_instruction,
          'video_index', v_video_idx + 1,
          'total_videos', v_total_videos
        ),
        'queued'
      )
      returning id into v_new_task_id;

      perform public.enqueue_agent_task(
        v_new_task_id,
        v_run.id,
        p_office_id,
        v_task.agent_id,
        'scriptwriter',
        0
      );
    elsif v_video_idx >= v_total_videos then
      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'task.completed',
        jsonb_build_object(
          'message', format('%s concluiu todos os %s vídeos!', v_task.agent_name, v_total_videos),
          'progress', 100,
          'videoNumber', v_video_idx,
          'totalVideos', v_total_videos
        )
      );

      insert into public.agent_events (office_id, agent_id, task_id, type, payload)
      values (
        p_office_id,
        v_task.agent_id,
        v_task.task_id,
        'agent.idle',
        jsonb_build_object(
          'message', format('%s finalizou todas as entregas e voltou para descansar na copa.', v_task.agent_name)
        )
      );

      update public.agents
      set status = 'idle'
      where id = v_task.agent_id;
    end if;
  end loop;

  select count(*)
  into v_remaining_tasks
  from public.tasks
  where run_id = v_run.id
    and status in ('queued', 'running');

  if v_remaining_tasks = 0 then
    update public.runs
    set
      status = 'completed',
      finished_at = now()
    where id = v_run.id;
  end if;

  return jsonb_build_object(
    'run_id', v_run.id,
    'processed_tasks', v_processed_count,
    'remaining_tasks', v_remaining_tasks,
    'run_status', case when v_remaining_tasks = 0 then 'completed' else 'running' end,
    'has_more', v_remaining_tasks > 0
  );
end;
$$;
