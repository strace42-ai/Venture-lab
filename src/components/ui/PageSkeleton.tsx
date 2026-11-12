import { Skeleton } from './primitives';

export function PageSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Загрузка…</span>
      <div className="page-head">
        <Skeleton h={12} w={140} />
        <Skeleton h={36} w="60%" r={8} />
        <Skeleton h={14} w="40%" />
      </div>
      <div className="grid grid--kpi">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="panel kpi">
            <Skeleton h={12} w={90} />
            <Skeleton h={28} w={60} r={8} />
            <Skeleton h={10} w="70%" />
          </div>
        ))}
      </div>
      <div className="panel" style={{ minHeight: 320 }}>
        <div className="panel__body" style={{ display: 'grid', gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} h={20} />
          ))}
        </div>
      </div>
    </div>
  );
}
