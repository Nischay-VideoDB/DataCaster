import { useStats } from "@/lib/api";

// Grouped order: shots, then cards/fouls, then set-pieces, then goals/saves.
// Separators are inserted between non-empty clusters at render time.
const CLUSTERS: { name: string; keys: string[] }[] = [
  { name: "shots",     keys: ["shot_on_target", "shot_off_target", "save", "goal"] },
  { name: "discipline", keys: ["yellow_card", "red_card", "foul"] },
  { name: "set_pieces", keys: ["corner", "free_kick", "throw_in", "penalty", "kick_off"] },
];

export function StatPills() {
  const stats = useStats(3000);
  const counts = stats?.counts ?? {};

  // Pre-compute which clusters have any non-zero value, then collect the
  // remainder (event types we don't cluster) under a final "other" group.
  const known = new Set(CLUSTERS.flatMap(c => c.keys));
  const otherKeys = Object.keys(counts)
    .filter(k => !known.has(k) && counts[k])
    .sort();

  const renderedClusters = CLUSTERS
    .map(c => ({ ...c, keys: c.keys.filter(k => counts[k]) }))
    .filter(c => c.keys.length > 0);

  if (otherKeys.length > 0) {
    renderedClusters.push({ name: "other", keys: otherKeys });
  }

  const total = renderedClusters.reduce((n, c) => n + c.keys.length, 0);

  return (
    <div className="min-w-0 border-b border-zinc-800 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Match stats
        </span>
        <span className="text-[10px] tabular-nums text-zinc-500">
          {stats?.total ?? 0} events
        </span>
      </div>
      {total === 0 ? (
        <div className="text-xs text-zinc-500">no events yet</div>
      ) : (
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 pr-3 [scrollbar-width:thin]">
          {renderedClusters.map((cluster, idx) => (
            <div key={cluster.name} className="flex shrink-0 items-center gap-1.5">
              {idx > 0 && (
                <div className="h-4 w-px shrink-0 bg-zinc-800" aria-hidden="true" />
              )}
              {cluster.keys.map(k => (
                <div
                  key={k}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-zinc-900 px-2 py-1"
                >
                  <span className="text-[10px] uppercase tracking-wider text-zinc-400">
                    {k.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-xs font-medium tabular-nums text-zinc-200">
                    {counts[k]}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
