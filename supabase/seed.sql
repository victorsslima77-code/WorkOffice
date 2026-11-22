-- ==============================================================================
-- WorkOffice — Seed SQL Local / Reset (espelha 20261122000003_seed_youtube_shorts_template.sql)
-- ==============================================================================
-- A seed do template "Estudio de Shorts para YouTube" e seus 3 cargos e aplicada
-- de forma idempotente via migration 20261122000003_seed_youtube_shorts_template.sql.
select slug, name, max_agents from public.office_templates where slug = 'youtube-shorts-studio';
