-- ==============================================================================
-- Etapa 2 (Seed Idempotente): Template "Estudio de Shorts para YouTube" e 3 Cargos
-- Baseado em assets/raw/office.jpg (3 baias, sala de reuniao, copa e corredor)
-- ==============================================================================

with upserted_template as (
  insert into public.office_templates (
    slug,
    name,
    description,
    max_agents,
    rooms,
    map_config
  )
  values (
    'youtube-shorts-studio',
    'Estúdio de Shorts para YouTube',
    'Escritório especializado em transformar episódios de podcasts e vídeos longos em Shorts virais: pesquisa de pauta em alta, corte vertical 9:16 com legendas e publicação agendada com monitoramento de métricas.',
    3,
    '{
      "template_slug": "youtube-shorts-studio",
      "image_asset": "/assets/office.png",
      "image_size": { "width": 1376, "height": 768 },
      "rooms": [
        { "id": "meeting", "name": "Sala de Reunião", "type": "meeting" },
        { "id": "lounge", "name": "Copa e Descanso", "type": "lounge" },
        { "id": "hall", "name": "Corredor Central", "type": "corridor" },
        { "id": "bay_1", "name": "Baia 1 — Pesquisa & Roteiro", "type": "workstation", "desk_slot": "desk_1" },
        { "id": "bay_2", "name": "Baia 2 — Edição de Vídeo", "type": "workstation", "desk_slot": "desk_2" },
        { "id": "bay_3", "name": "Baia 3 — Publicação & Analytics", "type": "workstation", "desk_slot": "desk_3" }
      ],
      "hotspots": {
        "spawn_door": { "room": "hall", "grid": [14, 10], "facing": "down" },
        "meeting_table": { "room": "meeting", "grid": [8, 8], "facing": "up_right" },
        "whiteboard": { "room": "meeting", "grid": [10, 6], "facing": "up_right" },
        "coffee_machine": { "room": "lounge", "grid": [5, 16], "facing": "up_left" },
        "foosball": { "room": "lounge", "grid": [7, 18], "facing": "down" },
        "desk_1": { "room": "bay_1", "chair_grid": [23, 8], "shelf_grid": [20, 7], "facing": "up_right" },
        "desk_2": { "room": "bay_2", "chair_grid": [23, 13], "shelf_grid": [20, 12], "facing": "up_right" },
        "desk_3": { "room": "bay_3", "chair_grid": [23, 18], "shelf_grid": [20, 17], "facing": "up_right" }
      }
    }'::jsonb,
    '{
      "projection": "isometric_2_1",
      "grid_cols": 32,
      "grid_rows": 24,
      "tile_width": 64,
      "tile_height": 32,
      "default_zoom": 1,
      "zoom_levels": [1, 2, 3]
    }'::jsonb
  )
  on conflict (slug) do update set
    name = excluded.name,
    description = excluded.description,
    max_agents = excluded.max_agents,
    rooms = excluded.rooms,
    map_config = excluded.map_config
  returning id
)
insert into public.roles (
  template_id,
  slug,
  name,
  scope,
  input_schema,
  output_schema,
  default_effort,
  allowed_tools,
  system_prompt,
  workstation_type
)
select
  t.id,
  r.slug,
  r.name,
  r.scope,
  r.input_schema::jsonb,
  r.output_schema::jsonb,
  r.default_effort,
  r.allowed_tools,
  r.system_prompt,
  r.workstation_type
from upserted_template t
cross join (
  values
    (
      'scriptwriter',
      'Roteirista / Pesquisador',
      'Monitorar temas em alta relacionados ao tópico/podcast alvo, analisar episódios recentes e selecionar os trechos com maior potencial de retenção em Shorts.',
      '{
        "type": "object",
        "required": ["podcast_name", "channel_url", "topic", "clip_count"],
        "properties": {
          "podcast_name": { "type": "string" },
          "channel_url": { "type": "string", "format": "uri" },
          "topic": { "type": "string" },
          "clip_count": { "type": "integer", "minimum": 1, "maximum": 5 }
        }
      }',
      '{
        "type": "object",
        "required": ["clips"],
        "properties": {
          "clips": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["source_url", "start_sec", "end_sec", "hook", "suggested_title", "rationale", "score"],
              "properties": {
                "source_url": { "type": "string", "format": "uri" },
                "start_sec": { "type": "number", "minimum": 0 },
                "end_sec": { "type": "number", "minimum": 5 },
                "hook": { "type": "string" },
                "suggested_title": { "type": "string" },
                "rationale": { "type": "string" },
                "score": { "type": "number", "minimum": 0, "maximum": 100 }
              }
            }
          }
        }
      }',
      'medium',
      array['web_search', 'youtube_list_videos', 'fetch_transcript', 'read_source'],
      'Você é o Roteirista e Pesquisador de Shorts. Seu objetivo é encontrar momentos de altíssima retenção (até 60 segundos) em episódios de podcast sobre o tópico solicitado, entregando timestamps exatos, gancho de abertura nos primeiros 3 segundos e títulos magnéticos.',
      'research_desk'
    ),
    (
      'video_editor',
      'Editor de Vídeo',
      'Baixar os trechos aprovados do podcast, converter para formato vertical (9:16, até 60s), gerar transcrição precisa e queimar legendas estilizadas no vídeo.',
      '{
        "type": "object",
        "required": ["clips"],
        "properties": {
          "clips": { "type": "array" }
        }
      }',
      '{
        "type": "object",
        "required": ["edited_shorts"],
        "properties": {
          "edited_shorts": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["storage_path", "subtitle_path", "duration_sec", "resolution", "suggested_title"],
              "properties": {
                "storage_path": { "type": "string" },
                "subtitle_path": { "type": "string" },
                "duration_sec": { "type": "number", "maximum": 60 },
                "resolution": { "type": "string" },
                "suggested_title": { "type": "string" }
              }
            }
          }
        }
      }',
      'medium',
      array['download_video_segment', 'transcribe_audio', 'cut_vertical_short', 'burn_subtitles', 'upload_artifact'],
      'Você é o Editor de Vídeo de Shorts. Seu trabalho é recortar os segmentos indicados no briefing de pesquisa em proporção 9:16 (1080x1920), sincronizar e queimar legendas dinâmicas e armazenar os arquivos finais prontos para publicação.',
      'editing_desk'
    ),
    (
      'publisher_analyst',
      'Publicador / Analista',
      'Publicar os Shorts no canal do YouTube conectado via OAuth (com título, descrição, hashtags e agendamento) e coletar métricas iniciais de desempenho.',
      '{
        "type": "object",
        "required": ["edited_shorts"],
        "properties": {
          "edited_shorts": { "type": "array" },
          "publish_visibility": { "type": "string", "enum": ["private", "unlisted", "public"] }
        }
      }',
      '{
        "type": "object",
        "required": ["published_videos"],
        "properties": {
          "published_videos": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["youtube_video_id", "url", "title", "visibility", "scheduled_at"],
              "properties": {
                "youtube_video_id": { "type": "string" },
                "url": { "type": "string", "format": "uri" },
                "title": { "type": "string" },
                "visibility": { "type": "string" },
                "scheduled_at": { "type": "string" }
              }
            }
          }
        }
      }',
      'low',
      array['youtube_upload_short', 'youtube_schedule_video', 'youtube_fetch_analytics'],
      'Você é o Publicador e Analista de Canal do YouTube. Você publica cada Short renderizado com metadados otimizados de SEO/hashtags e monitora visualizações, likes, comentários e retenção.',
      'publishing_desk'
    )
) as r(
  slug,
  name,
  scope,
  input_schema,
  output_schema,
  default_effort,
  allowed_tools,
  system_prompt,
  workstation_type
)
on conflict (template_id, slug) do update set
  name = excluded.name,
  scope = excluded.scope,
  input_schema = excluded.input_schema,
  output_schema = excluded.output_schema,
  default_effort = excluded.default_effort,
  allowed_tools = excluded.allowed_tools,
  system_prompt = excluded.system_prompt,
  workstation_type = excluded.workstation_type;

-- Definir o DAG do workflow do template "Estudio de Shorts para YouTube"
insert into public.workflow_definitions (
  template_id,
  version,
  steps
)
select
  t.id,
  1,
  '[
    {
      "step_order": 1,
      "role_slug": "scriptwriter",
      "desk_slot": "desk_1",
      "next_role_slugs": ["video_editor"]
    },
    {
      "step_order": 2,
      "role_slug": "video_editor",
      "desk_slot": "desk_2",
      "next_role_slugs": ["publisher_analyst"]
    },
    {
      "step_order": 3,
      "role_slug": "publisher_analyst",
      "desk_slot": "desk_3",
      "next_role_slugs": []
    }
  ]'::jsonb
from public.office_templates t
where t.slug = 'youtube-shorts-studio'
on conflict (template_id, version) do update set
  steps = excluded.steps;
