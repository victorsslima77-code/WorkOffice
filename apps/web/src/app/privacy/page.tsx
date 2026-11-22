import Link from 'next/link';

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10 text-slate-200">
      <div className="border-2 border-amber-500/80 bg-slate-900 p-8 shadow-[6px_6px_0px_0px_rgba(245,158,11,0.28)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <span className="inline-block border border-amber-400/50 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300">
              WorkOffice // Privacidade &amp; Segurança
            </span>
            <h1 className="mt-1 text-2xl font-bold text-white">
              Política de Privacidade e Segurança do Cofre de Chaves (Vault)
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
              1. Proteção de Chaves BYOK e Tokens OAuth no Supabase Vault
            </h2>
            <p>
              Suas chaves de API (Anthropic, Google Gemini, OpenAI) e seu{' '}
              <code>refresh_token</code> OAuth 2.0 do YouTube <strong>jamais</strong> são
              armazenados em texto puro em tabelas comuns ou retornados para o navegador após o
              cadastro:
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-6 text-slate-300">
              <li>
                Os segredos são criptografados em repouso via extensão nativa{' '}
                <strong>Supabase Vault</strong> (<code>vault.create_secret</code> /{' '}
                <code>pgsodium</code>);
              </li>
              <li>
                A interface web armazena e exibe apenas metadados mascarados (provedor, rótulo e os
                últimos 4 caracteres em <code>last4</code>);
              </li>
              <li>
                A descriptografia ocorre exclusivamente em memória pelo processo Worker autenticado
                com <code>service_role</code> no exato instante da execução da tarefa, sendo
                proibido registrar valores de chaves em logs, eventos Realtime ou traces.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              2. Isolamento Multi-Tenant (Row Level Security e Storage Privado)
            </h2>
            <p>
              Todas as tabelas de domínio (<code>profiles</code>, <code>offices</code>,{' '}
              <code>agents</code>, <code>agent_credentials</code>, <code>office_integrations</code>,{' '}
              <code>runs</code>, <code>tasks</code>, <code>agent_events</code>,{' '}
              <code>llm_calls</code>, <code>artifacts</code> e <code>video_metrics</code>) possuem{' '}
              <strong>Row Level Security (RLS)</strong> habilitada e forçada no PostgreSQL,
              garantindo que cada usuário acesse estritamente os dados dos seus próprios
              escritórios.
            </p>
            <p className="mt-2">
              Os vídeos verticais MP4 e arquivos de legenda <code>.srt</code> são gravados nos
              buckets privados <code>shorts</code> e <code>artifacts</code> do Supabase Storage,
              particionados por <code>{'{office_id}/{run_id}/...'}</code> e protegidos por políticas
              de propriedade.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              3. Dados Coletados e Telemetria de Observabilidade
            </h2>
            <p>
              Coletamos apenas seu e-mail de cadastro, nome de exibição e as métricas operacionais
              dos seus agentes (contagem de tokens de entrada/saída/raciocínio, latência em
              milissegundos, custo estimado em USD e artefatos das runs) para exibição no seu
              próprio painel de Observabilidade &amp; Traces.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-base font-bold uppercase tracking-wider text-amber-300">
              4. Exclusão de Dados e Revogação de Credenciais (LGPD / GDPR)
            </h2>
            <p>
              Você pode revogar qualquer credencial BYOK ou desconectar sua integração OAuth do
              YouTube a qualquer momento em <code>/app/credentials</code>. A revogação exclui
              imediatamente o segredo criptografado da tabela <code>vault.secrets</code>.
            </p>
          </section>
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-slate-800 pt-4 text-xs text-slate-400">
          <span>Conformidade LGPD &amp; Google API Services User Data Policy</span>
          <Link href="/terms" className="font-bold text-amber-400 hover:underline">
            Ver Termos de Uso →
          </Link>
        </div>
      </div>
    </main>
  );
}
