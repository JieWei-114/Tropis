/**
 * STACK FEATURE — static informational card.
 */
export function VaultCard() {
  return (
    <>
      {/* ── Vault info card ── */}
      <div className="flex flex-col gap-4 rounded-[14px] border border-[#3a2a4a] bg-surface p-5">
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[22px]">🔐</span>
          <div>
            <span className="block text-[15px] font-bold text-foreground">
              HashiCorp Vault — Secret Management
            </span>
            <span className="mt-0.5 inline-block rounded bg-[#2e1a4a] px-2 py-0.5 text-[10px] font-semibold tracking-[0.5px] text-[#d4a8f0] uppercase">
              Backend only
            </span>
          </div>
          <a
            href="http://localhost:8200"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto rounded-lg border border-[#3a2a4a] px-3 py-1.5 text-xs text-[#d4a8f0] no-underline transition-colors hover:bg-[#2e1a4a]"
          >
            Open UI ↗
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[160px] flex-1 flex-col gap-1 rounded-[10px] border border-[#1a3a5a] bg-[#0f1a2e] px-3.5 py-3">
            <span className="text-xs font-bold text-foreground">
              Frontend (React)
            </span>
            <span className="font-mono text-[11px] whitespace-pre-line text-[#8080b0]">
              Public URLs only
              <br />
              VITE_API_BASE_URL
              <br />
              VITE_WS_URL
            </span>
            <span className="mt-0.5 text-[10px] text-[#505080]/55">
              No secrets. Ever.
            </span>
          </div>
          <div className="shrink-0 text-center text-[11px] whitespace-nowrap text-[#505080]">
            <span>API calls →</span>
          </div>
          <div className="flex min-w-[160px] flex-1 flex-col gap-1 rounded-[10px] border border-[#1a5a2a] bg-[#0f2a1a] px-3.5 py-3">
            <span className="text-xs font-bold text-foreground">
              Backend (NestJS)
            </span>
            <span className="font-mono text-[11px] whitespace-pre-line text-[#8080b0]">
              VaultModule loads secrets
              <br />
              at bootstrap into process.env
            </span>
            <span className="mt-0.5 text-[10px] text-[#505080]/55">
              JWT_SECRET · DB passwords · API keys
            </span>
          </div>
          <div className="shrink-0 text-center text-[11px] whitespace-nowrap text-[#505080]">
            <span>← secrets at boot</span>
          </div>
          <div className="flex min-w-[160px] flex-1 flex-col gap-1 rounded-[10px] border border-[#5a2a7a] bg-[#2a1a3a] px-3.5 py-3">
            <span className="text-xs font-bold text-foreground">
              Vault (KV v2)
            </span>
            <span className="font-mono text-[11px] whitespace-pre-line text-[#8080b0]">
              secret/tropis
              <br />
              secret/tropis/db
              <br />
              secret/tropis/auth
            </span>
            <span className="mt-0.5 text-[10px] text-[#505080]/55">
              Token: dev-root-token
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          {[
            {
              path: 'secret/tropis',
              desc: 'All secrets — what the app reads at boot',
            },
            {
              path: 'secret/tropis/db',
              desc: 'MongoDB · PostgreSQL · ClickHouse · Redis · ES',
            },
            {
              path: 'secret/tropis/auth',
              desc: 'JWT_SECRET · JWT_EXPIRES_IN',
            },
            { path: 'secret/tropis/messaging', desc: 'Pulsar URL · Redis' },
            {
              path: 'secret/tropis/storage',
              desc: 'MinIO endpoint · access key · secret key',
            },
            {
              path: 'secret/tropis/smtp',
              desc: 'SMTP host · port · from address',
            },
          ].map((p) => (
            <div
              key={p.path}
              className="flex items-center gap-3 rounded-md bg-[#0a0a14] px-2.5 py-1.5"
            >
              <code className="min-w-[240px] shrink-0 font-mono text-[11px] text-[#d4a8f0]">
                {p.path}
              </code>
              <span className="text-[11px] text-muted">{p.desc}</span>
            </div>
          ))}
        </div>

        <div className="mb-4 flex flex-col gap-2.5">
          <div className="flex items-start gap-3 rounded-lg border border-[#1a1a2e] bg-[#0d0d1a] px-3.5 py-2.5 [&_code]:rounded-[3px] [&_code]:bg-[#1a1a2e] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#d4a8f0] [&_span:not(:first-child)]:text-xs [&_span:not(:first-child)]:leading-[1.5] [&_span:not(:first-child)]:text-[#8080b0] [&_strong]:text-[13px] [&_strong]:text-[#d4a8f0] [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5">
            <span className="mt-px shrink-0 text-lg">🔑</span>
            <div>
              <strong>AppRole auth</strong>
              <span>
                CI/CD injects <code>VAULT_ROLE_ID</code> +{' '}
                <code>VAULT_SECRET_ID</code> → scoped short-lived token. Never
                store credentials in files.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-[#1a1a2e] bg-[#0d0d1a] px-3.5 py-2.5 [&_code]:rounded-[3px] [&_code]:bg-[#1a1a2e] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#d4a8f0] [&_span:not(:first-child)]:text-xs [&_span:not(:first-child)]:leading-[1.5] [&_span:not(:first-child)]:text-[#8080b0] [&_strong]:text-[13px] [&_strong]:text-[#d4a8f0] [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5">
            <span className="mt-px shrink-0 text-lg">♻️</span>
            <div>
              <strong>Token auto-renewal</strong>
              <span>
                <code>token.renewSelf()</code> fires at 1/3 of TTL — the app
                stays authenticated past the initial 1h token lifetime without a
                restart.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-[#1a1a2e] bg-[#0d0d1a] px-3.5 py-2.5 [&_code]:rounded-[3px] [&_code]:bg-[#1a1a2e] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#d4a8f0] [&_span:not(:first-child)]:text-xs [&_span:not(:first-child)]:leading-[1.5] [&_span:not(:first-child)]:text-[#8080b0] [&_strong]:text-[13px] [&_strong]:text-[#d4a8f0] [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5">
            <span className="mt-px shrink-0 text-lg">🔒</span>
            <div>
              <strong>Transit encryption</strong>
              <span>
                PII (email) in ClickHouse audit logs is encrypted via{' '}
                <code>transit/keys/user-data</code>. The key never leaves Vault
                — only <code>vault:v1:…</code> ciphertext is stored.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-[#1a1a2e] bg-[#0d0d1a] px-3.5 py-2.5 [&_code]:rounded-[3px] [&_code]:bg-[#1a1a2e] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#d4a8f0] [&_span:not(:first-child)]:text-xs [&_span:not(:first-child)]:leading-[1.5] [&_span:not(:first-child)]:text-[#8080b0] [&_strong]:text-[13px] [&_strong]:text-[#d4a8f0] [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5">
            <span className="mt-px shrink-0 text-lg">🗄️</span>
            <div>
              <strong>Dynamic PostgreSQL credentials</strong>
              <span>
                Vault issues a temporary DB user (TTL=1h) on startup via{' '}
                <code>database/creds/tropis-app</code>. No static DB password —
                Vault auto-revokes the user on expiry.
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-dashed border-[#2a2a4a] bg-[#0d0d1a] px-3.5 py-2.5 text-xs leading-[1.6] text-[#8080b0] [&_code]:rounded-[3px] [&_code]:bg-[#1a1a2e] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#d4a8f0]">
          <strong>To activate:</strong> run{' '}
          <code>docker compose up -d vault vault-init</code>, then add to{' '}
          <code>apps/backend/.env</code>:{' '}
          <code>VAULT_ADDR=http://localhost:8200</code> +{' '}
          <code>VAULT_TOKEN=dev-root-token</code> (or AppRole creds from{' '}
          <code>docker logs tropis_vault_init</code>).
        </div>
      </div>
    </>
  );
}
