/**
 * STACK FEATURE — static informational card.
 */
export function PatternsCard() {
  return (
    <>
      {/* ── Production patterns card ── */}
      <div className="flex flex-col gap-3.5 rounded-[14px] border border-[#1a3a2a] bg-[#0f1a14] p-5">
        <div className="flex items-center gap-2.5">
          <span className="text-xl">⚙️</span>
          <span className="text-[15px] font-semibold text-[#7ae8a8]">
            Production-grade patterns
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3 max-md:grid-cols-1">
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-[#1a3020] bg-[#0d1510] px-3.5 py-3">
            <span className="text-[13px] font-semibold text-[#a8e8c0]">
              🏷️ Domain events (EventEmitter2)
            </span>
            <span className="text-xs leading-[1.6] text-[#6a9a7a] [&_code]:rounded-[3px] [&_code]:bg-[#0d1a10] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#7ae8a8]">
              <code>UserService</code> emits typed events;{' '}
              <code>UserEventHandlers</code> handles ES indexing, pgvector
              upsert, BullMQ notification, and WS broadcast — fully decoupled
              from the service layer.
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-[#1a3020] bg-[#0d1510] px-3.5 py-3">
            <span className="text-[13px] font-semibold text-[#a8e8c0]">
              🚦 Structured error codes
            </span>
            <span className="text-xs leading-[1.6] text-[#6a9a7a] [&_code]:rounded-[3px] [&_code]:bg-[#0d1a10] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#7ae8a8]">
              Every error returns{' '}
              <code>{'{ code, message, traceId, path, timestamp }'}</code>.
              Stable machine-readable <code>code</code> (e.g.{' '}
              <code>NOT_FOUND</code>, <code>RATE_LIMITED</code>) plus a{' '}
              <code>traceId</code> that links the user-visible error to the
              server log.
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-[#1a3020] bg-[#0d1510] px-3.5 py-3">
            <span className="text-[13px] font-semibold text-[#a8e8c0]">
              🗃️ PostgreSQL migrations (node-pg-migrate)
            </span>
            <span className="text-xs leading-[1.6] text-[#6a9a7a] [&_code]:rounded-[3px] [&_code]:bg-[#0d1a10] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-[#7ae8a8]">
              Versioned schema under <code>apps/backend/migrations/</code>.
              Initial migration creates the <code>user_vectors</code> IVFFlat
              index and <code>documents</code> table. Run with{' '}
              <code>pnpm --filter backend migrate:up</code>.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
