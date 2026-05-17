import { Button } from "@/components/ui/button";
import { EventBadge } from "@/components/EventBadge";
import { IndexingProgress } from "@/components/IndexingProgress";
import type { DataCasterEvent } from "@/lib/types";
import { Play, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { seekPlayer } from "@/lib/playerControl";

/**
 * Compute the in-video timestamp (seconds from playback start) for an event.
 * In VOD mode the backend stores `unix_ts = started_at + scene.start`, so the
 * delta is the offset within the source video. For RTStream/live this also
 * yields seconds-since-pipeline-start, which is approximately right for
 * replaying the live segment in the same player.
 *
 * If startedAt isn't loaded yet (the React state polls /api/health every 3s),
 * fall back to interpreting `unix_ts` as the offset itself for tiny values
 * (< 24h) so we never show a wall-clock '1:15:19 AM' style timestamp during
 * the first few seconds after a page load.
 */
function eventVideoSeconds(event: DataCasterEvent, startedAt: number | null): number {
  if (startedAt && event.unix_ts >= startedAt) {
    return Math.max(0, event.unix_ts - startedAt);
  }
  // unix_ts looks like a real epoch (>1B) and we don't have started_at yet —
  // best-effort: treat 0 as the safe fallback. Caller hides the timestamp
  // until it can render correctly via useEffect re-render once started_at
  // arrives.
  if (event.unix_ts > 1_000_000_000) return 0;
  return Math.max(0, event.unix_ts);
}

function fmtTime(unix: number, started: number | null): string {
  // Compute the in-video offset and always render MM:SS — never fall through
  // to a wall-clock string. If the offset exceeds 99 minutes (a long match)
  // we render H:MM:SS; otherwise just MM:SS.
  let offset: number;
  if (started && unix >= started) {
    offset = Math.max(0, Math.floor(unix - started));
  } else if (unix > 1_000_000_000) {
    // Epoch-shaped timestamp without a known start — show '--:--' rather
    // than a misleading '0:00' or a wall-clock time.
    return "--:--";
  } else {
    offset = Math.max(0, Math.floor(unix));
  }
  const h = Math.floor(offset / 3600);
  const m = Math.floor((offset % 3600) / 60);
  const s = offset % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

type FilterKey = string;

interface FilterDef {
  key: FilterKey;
  label: string;
  types: Set<string> | null;
}

// Filter strip presets per content_type. The `all` row's `types: null`
// signals "no filter" to the row-renderer below.
const FILTERS_FOOTBALL: FilterDef[] = [
  { key: "all",        label: "All",        types: null },
  { key: "goals",      label: "Goals",      types: new Set(["goal"]) },
  { key: "cards",      label: "Cards",      types: new Set(["yellow_card", "red_card"]) },
  { key: "saves",      label: "Saves",      types: new Set(["save"]) },
  { key: "shots",      label: "Shots",      types: new Set(["shot_on_target", "shot_off_target"]) },
  { key: "set_pieces", label: "Set pieces", types: new Set(["corner", "free_kick", "throw_in", "penalty", "kick_off"]) },
];

const FILTERS_DESCRIBE: FilterDef[] = [
  { key: "all",         label: "All",         types: null },
  { key: "speakers",    label: "Speakers",    types: new Set(["speaker"]) },
  { key: "actions",     label: "Actions",     types: new Set(["action"]) },
  { key: "transitions", label: "Transitions", types: new Set(["scene_change"]) },
  { key: "text",        label: "Text",        types: new Set(["text_overlay"]) },
];

const GROUP_WINDOW_SEC = 10;

interface GroupedRow {
  representative: DataCasterEvent;
  count: number;
  earliestTs: number;
  latestTs: number;
}

/**
 * Walk events sorted ascending by ts. Merge adjacent events with the same
 * event_type + team within GROUP_WINDOW_SEC into a single GroupedRow.
 * Caller is responsible for choosing display order afterwards.
 */
function groupRuns(events: DataCasterEvent[]): GroupedRow[] {
  if (events.length === 0) return [];
  const asc = [...events].sort((a, b) => a.unix_ts - b.unix_ts);
  const out: GroupedRow[] = [];
  for (const e of asc) {
    const tail = out[out.length - 1];
    if (
      tail &&
      tail.representative.event_type === e.event_type &&
      (tail.representative.team ?? null) === (e.team ?? null) &&
      e.unix_ts - tail.latestTs <= GROUP_WINDOW_SEC
    ) {
      tail.count += 1;
      tail.latestTs = e.unix_ts;
    } else {
      out.push({
        representative: e,
        count: 1,
        earliestTs: e.unix_ts,
        latestTs: e.unix_ts,
      });
    }
  }
  return out;
}

interface Props {
  events: DataCasterEvent[];
  startedAt: number | null;
  onSelect: (e: DataCasterEvent) => void;
  /** Drives filter-strip composition. "football" → goals/cards/etc.,
   *  "describe" → speakers/actions/etc. Defaults to football for back-compat. */
  mode?: "football" | "describe";
  /** How many scene-windows VideoDB has produced so far. Surfaced in the
   *  empty-state copy so users see "indexing… N windows so far" instead of
   *  a silent "waiting for events" while the model chews through the video.
   *  null = not started yet, 0 = started but nothing back yet. */
  indexedScenes?: number | null;
  /** VOD source runtime in seconds. Drives the projected total scene-window
   *  count (length / 6) for the indexing ETA bar. */
  videoLengthS?: number | null;
  /** Whether a pipeline is currently active. Gates the Resync button — no
   *  point exposing it when there's nothing to resync. */
  pipelineActive?: boolean;
  /** Called after a successful resync so the parent can clear local
   *  in-memory event state. Resync wipes server-side; the local list needs
   *  a complementary reset. */
  onResynced?: () => void;
  /** Open the parent's Reel dialog after a successful compose. Result is
   *  whatever /api/highlights/reel returned — see lib/api.ts:makeReel. */
  onReelComposed?: (result: Awaited<ReturnType<typeof api.makeReel>>) => void;
}

export function EventTimeline({
  events, startedAt, onSelect, mode = "football", indexedScenes, videoLengthS,
  pipelineActive = false, onResynced, onReelComposed,
}: Props) {
  const [autoStick, setAutoStick] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [resyncing, setResyncing] = useState(false);
  const [reeling, setReeling] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleResync = async () => {
    if (resyncing || !pipelineActive) return;
    if (!confirm("Resync this video's timeline? This wipes the existing events and re-runs scene indexing under the current prompt + thresholds (3-6 minutes).")) return;
    setResyncing(true);
    try {
      await api.resyncEvents();
      onResynced?.();
    } catch { /* humanize will surface via the next health probe */ }
    finally { setResyncing(false); }
  };

  // "Reel last 3" composes a 9:16 highlight from the most-recent events
  // and posts it to Telegram (when configured). Disabled with <3 events;
  // spinner while in flight; result lifted to App via onReelComposed for
  // the dialog mount.
  const reelDisabled = !pipelineActive || events.length < 3 || reeling;
  const handleReel = async () => {
    if (reelDisabled) return;
    setReeling(true);
    try {
      const result = await api.makeReel(3, "vertical", "telegram");
      onReelComposed?.(result);
    } catch {
      // The backend humanize layer surfaces this via the global error
      // probe; nothing to do here.
    } finally {
      setReeling(false);
    }
  };

  // Choose the active filter set per content mode. Reset the active filter
  // back to "all" when the mode flips so a stale "goals" filter doesn't
  // freeze the list to nothing in describe mode.
  const FILTERS = mode === "describe" ? FILTERS_DESCRIBE : FILTERS_FOOTBALL;
  useEffect(() => { setFilter("all"); }, [mode]);

  const filtered = useMemo(() => {
    const f = FILTERS.find(x => x.key === filter);
    if (!f || f.types === null) return events;
    const set = f.types;
    return events.filter(e => set.has(e.event_type));
  }, [events, filter, FILTERS]);

  // Per-filter event counts so the tab strip reads "ALL 12 · GOALS 3 · ..."
  // and the user can see at a glance which categories are populated.
  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: events.length };
    for (const f of FILTERS) {
      if (f.types) counts[f.key] = 0;
    }
    for (const e of events) {
      for (const f of FILTERS) {
        if (f.types && f.types.has(e.event_type)) counts[f.key] += 1;
      }
    }
    return counts;
  }, [events, FILTERS]);

  const rows = useMemo(() => {
    const grouped = groupRuns(filtered);
    // Display newest-first (descending by earliest ts of the group).
    return grouped.sort((a, b) => b.earliestTs - a.earliestTs);
  }, [filtered]);

  useEffect(() => {
    if (autoStick && ref.current) ref.current.scrollTop = 0;
  }, [rows, autoStick]);

  const handleEventClick = (e: DataCasterEvent) => {
    const seconds = eventVideoSeconds(e, startedAt);
    const seeked = seekPlayer(seconds);
    if (!seeked) {
      // Fallback for live/RTStream contexts where no <video> is attached:
      // let the parent handle it (scrub via clip URL, etc.).
      onSelect(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-zinc-400">
            Event timeline
          </span>
          <span className="rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">
            {filtered.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setAutoStick(!autoStick)}
          >
            {autoStick ? "auto-scroll on" : "auto-scroll off"}
          </Button>
          {pipelineActive && (
            <Button
              variant="ghost" size="sm"
              className="h-6 px-2 text-[11px] text-zinc-400 hover:text-emerald-300"
              onClick={handleResync}
              disabled={resyncing}
              title="Wipe and re-classify this video's events from scratch (3-6 min)"
            >
              <RefreshCw className={`h-3 w-3 ${resyncing ? "animate-spin" : ""}`} />
              <span className="ml-1">{resyncing ? "Resyncing…" : "Resync"}</span>
            </Button>
          )}
          {pipelineActive && (
            <button
              type="button"
              onClick={handleReel}
              disabled={reelDisabled}
              title={
                events.length < 3
                  ? "Need at least 3 events to compose a reel"
                  : "Compose a 9:16 reel from the last 3 events and send it to Telegram"
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium tracking-wide text-emerald-200 shadow-sm transition hover:border-emerald-400/60 hover:bg-emerald-500/25 hover:text-emerald-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500 disabled:shadow-none"
            >
              <Send className={`h-3.5 w-3.5 ${reeling ? "animate-pulse" : ""}`} />
              <span>{reeling ? "Composing reel…" : "Reel last 3"}</span>
            </button>
          )}
        </div>
      </header>

      {/* Filter tab strip — each tab shows its event count so the user
          knows at a glance which categories are populated. */}
      <div className="flex flex-nowrap gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5 [scrollbar-width:thin]">
        {FILTERS.map(f => {
          const active = filter === f.key;
          const count = filterCounts[f.key];
          const hasEvents = count > 0;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                "shrink-0 inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
                (active
                  ? "bg-zinc-800 text-zinc-100"
                  : hasEvents
                    ? "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    : "text-zinc-600 hover:bg-zinc-900 hover:text-zinc-400")
              }
            >
              <span>{f.label}</span>
              <span
                className={
                  "rounded-sm px-1 py-px text-[10px] tabular-nums normal-case tracking-normal " +
                  (active
                    ? "bg-zinc-900 text-zinc-300"
                    : hasEvents
                      ? "bg-zinc-900 text-zinc-300"
                      : "bg-zinc-900/50 text-zinc-600")
                }
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* One scroll container for the whole list. Vertical scroll for the
          row stream, horizontal scroll for long summaries — every row pans
          together because they share the same inner track width. */}
      <div
        ref={ref}
        className="flex-1 min-h-0 overflow-auto [scrollbar-width:thin]"
      >
        {rows.length === 0 && (
          <IndexingProgress
            startedAt={startedAt}
            videoLengthS={videoLengthS ?? null}
            indexedScenes={indexedScenes ?? null}
          />
        )}
        <div className="inline-block min-w-full divide-y divide-zinc-800/50">
          {rows.map(row => {
            const e = row.representative;
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={() => handleEventClick(e)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") handleEventClick(e); }}
                className="group flex cursor-pointer items-center gap-3 whitespace-nowrap px-3 py-1.5 text-left hover:bg-zinc-900/50"
              >
                <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-zinc-500 underline-offset-2 group-hover:text-zinc-200 group-hover:underline">
                  <Play
                    className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                  {fmtTime(row.earliestTs, startedAt)}
                </span>
                <EventBadge type={e.event_type} />
                <span className="text-xs text-zinc-300">
                  {e.summary || e.event_type.replace(/_/g, " ")}
                </span>
                {row.count > 1 && (
                  <span className="shrink-0 rounded-sm bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-300">
                    × {row.count}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10px] text-zinc-600 tabular-nums">
                  {Math.round((e.confidence ?? 0) * 100)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function useCommentaryGenerator(eventId: number | null, autoStyle = "excited") {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    if (!eventId) return;
    setBusy(true); setError(null);
    try { await api.generateCommentary(eventId, autoStyle); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return { generate, busy, error };
}
