import type { PipelineState } from "@/lib/types";

interface Props {
  pipeline: PipelineState | null;
  busy?: boolean;
  eventCount?: number;
}

/** Compact connection-state indicator used in the header.
 *  Replaces the cryptic "rt=…" + "sandbox · …" debug chips with one
 *  human-readable pill: IDLE / CONNECTING… / LIVE · N events */
export function StatusPill({ pipeline, busy = false, eventCount }: Props) {
  const live = !!pipeline?.started_at;
  const startingServer = !!pipeline?.starting_at && !live; // server says "in flight"
  const startingClient = busy && !live;                     // local POST in flight
  const starting = startingServer || startingClient;
  // VOD ingest isn't a live broadcast — labelling it "LIVE" misled users.
  // Use VOD when pipeline.source_type is "video" (a pre-recorded upload),
  // and reserve LIVE for the RTStream / live URL path.
  const isVod = pipeline?.source_type === "video";
  const liveLabel = isVod ? "VOD" : "LIVE";
  let label = "IDLE";
  let dot = "bg-zinc-600";
  if (starting) {
    label = "CONNECTING…";
    dot = "bg-amber-400 animate-pulse";
  } else if (live) {
    label = eventCount != null ? `${liveLabel} · ${eventCount} events` : liveLabel;
    dot = "bg-emerald-400 animate-pulse";
  }
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-300">
        {label}
      </span>
    </div>
  );
}
