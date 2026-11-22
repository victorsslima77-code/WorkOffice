import Link from 'next/link';

export default function TermsOfUsePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10 text-slate-200">
      <div className="border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.28)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <span className="inline-block border border-amber-400/50 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300">
              WorkOffice // Documento Legal
            </span>
            <h1 className="mt-1 text-2xl font-bold text-white">
              Termos de Uso e Responsabilidade sobre APIs e Direitos Autorais
            </h1>
          </div>
          <Link
            href="/"
            className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-bold uppercase text-slate-200 hover:border-amber-400"
          >
            ← Voltar ao Início
          </Link>
        </div>

        <div className="space-y-6 text-sm leading-relaxed text-slate-300">
          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              1. Modelo BYOK (Bring Your Own Key) e Custos de Provedores Externos
            </h2>
            <p>
              O WorkOffice opera sob o modelo <strong>Bring Your Own Key (BYOK)</strong>. Ao
              cadastrar chaves de API da <strong>Anthropic (Claude)</strong>,{' '}
              <strong>Google (Gemini)</strong> ou <strong>OpenAI (GPT)</strong> no Cofre de Chaves,
              você reconhece que todas as chamadas de inferência (`llm_calls`) realizadas pelos
              funcionários virtuais do seu escritório consomem diretamente a cota e o saldo da sua
              conta junto ao respectivo provedor.
            </p>
            <p className="mt-2">
              O WorkOffice disponibiliza estimativas de custo antes da execução, monitoramento em
              tempo real por tarefa e travas automáticas de orçamento mensal (
              <code>monthly_token_budget</code> com alerta em <strong>80%</strong> e pausa
              automática em <strong>100%</strong>), sendo responsabilidade do usuário configurar
              limites compatíveis com seu orçamento.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              2. Direitos Autorais, Fontes de Mídia e Termos do YouTube
            </h2>
            <p>
              O modelo de escritório <strong>Estúdio de Cortes &amp; YouTube Shorts</strong> utiliza
              ferramentas automatizadas (<code>yt-dlp</code>, <code>ffmpeg</code> e{' '}
              <code>YouTube Data API v3</code>) para pesquisar, recortar em formato vertical 9:16,
              legendar e publicar vídeos curtos. Ao disparar qualquer execução (<code>run</code>),
              você declara e garante que:
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-6 text-slate-300">
              <li>
                É o detentor legítimo dos direitos autorais do vídeo/podcast de origem, ou possui{' '}
                <strong>autorização expressa / licença compatível (ex.: Creative Commons)</strong>{' '}
                para recortar, transformar e republicar o conteúdo;
              </li>
              <li>
                Cumpre integralmente os{' '}
                <a
                  href="https://www.youtube.com/t/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-400 underline"
                >
                  Termos de Serviço do YouTube
                </a>{' '}
                e as Políticas do Google para Desenvolvedores ao conectar seu canal via OAuth 2.0;
              </li>
              <li>
                Não utilizará os agentes para violar direitos de imagem, propriedade intelectual de
                terceiros, gerar spam ou publicar conteúdo proibido pelas diretrizes da comunidade.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              3. Uso Aceitável, Proteção Anti-SSRF e Rate Limiting
            </h2>
            <p>
              Para garantir a segurança e a estabilidade multi-tenant da plataforma, todas as URLs
              fornecidas aos agentes passam por validação estrita contra{' '}
              <strong>Server-Side Request Forgery (SSRF)</strong>, bloqueando endereços locais,
              redes privadas, portas não-padrão e domínios de mídia não autorizados. Além disso, os
              endpoints de disparo de execuções (<code>create-run</code>) e gerenciamento de
              credenciais (<code>store-credential</code>) possuem limites de taxa (
              <em>Rate Limiting</em>) por usuário.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              4. Revogação e Controle de Atividades
            </h2>
            <p>
              Você pode interromper imediatamente o trabalho de qualquer funcionário virtual (ou
              mandar toda a equipe descansar na copa) a qualquer momento pelo painel do escritório,
              bem como rotacionar ou revogar suas chaves de API e tokens OAuth do YouTube com efeito
              imediato no Supabase Vault.
            </p>
          </section>
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-slate-800 pt-4 text-xs text-slate-400">
          <span>Última atualização: Novembro de 2026</span>
          <Link href="/privacy" className="font-bold text-amber-400 hover:underline">
            Ver Política de Privacidade →
          </Link>
        </div>
      </div>
    </main>
  );
}
