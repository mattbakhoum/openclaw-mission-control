export function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-[color:var(--accent)] to-[color:var(--accent-strong)] text-xs font-semibold text-white shadow-[0_2px_12px_-2px_rgba(201,95,58,0.4)]">
        <span className="font-heading tracking-[0.18em]">B·OS</span>
        {/* breathing pulse dot — "the system is awake" */}
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[color:var(--accent)] animate-constellation-pulse shadow-[0_0_6px_rgba(224,133,96,0.8)]" />
      </div>
      <div className="leading-tight">
        <div className="font-heading text-sm uppercase tracking-[0.26em] text-strong">
          BAKHOUM
          <span className="mx-1 text-[color:var(--accent)]">·</span>
          OS
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-quiet">
          mission control
        </div>
      </div>
    </div>
  );
}
