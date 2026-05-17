/**
 * IndexingProgress — real-time ETA for VOD scene indexing.
 *
 * Drives the empty-state copy on EventTimeline while VideoDB chews through
 * scene windows. Total expected windows is computed from the source's
 * runtime (videoLengthS / 6 — DataCaster indexes at time_based 6s windows).
 * Rate comes straight from `indexedScenes / elapsed`, smoothed by the fact
 * that the value updates every ~5s via /api/health + the SSE
 * `vod_progress` beacon. No demo math, no placeholder rates.
 */

import { useEffect, useState } from "react";

const KICKOFF_PHRASES = [
  "Lacing up the boots",
  "Walking out of the tunnel",
  "Coin toss in progress",
  "Captains shaking hands",
  "Lining up for kick-off",
  "Whistle in mouth",
  "Subs warming up on the touchline",
];

const MID_PHRASES = [
  "Reading the play",
  "Tracking the run",
  "Eyes on the back four",
  "Scouting the build-up",
  "Watching the press",
  "Charting set-pieces",
  "Logging tactical patterns",
];

interface Props {
  /** wall-clock seconds since /api/start (state.started_at). */
  startedAt: number | null;
  /** ceil(videoLengthS / 6) is the projected total scene-window count. */
  videoLengthS: number | null;
  /** Live count from /api/health.vod_indexed_scenes + SSE vod_progress. */
  indexedScenes: number | null;
  /** Once the user already has events, the parent stops rendering this
   *  component — the timeline replaces the empty state. */
}

const SCENE_WINDOW_S = 6;

function fmtRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "any moment";
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))}s remaining`;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `~${m}m ${s.toString().padStart(2, "0")}s remaining`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `~${h}h ${mm.toString().padStart(2, "0")}m remaining`;
}

export function IndexingProgress({
  startedAt, videoLengthS, indexedScenes,
}: Props) {
  // Tick once a second so the ETA decreases visibly between SSE beacons
  // (the backend only publishes vod_progress every ~5s).
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  // Fallback copy when we don't have enough data yet to project an ETA.
  if (!startedAt) {
    return (
      <div className="px-3 py-8 text-center text-xs text-zinc-500">
        Click Start to begin tracing events.
      </div>
    );
  }
  if (!videoLengthS || videoLengthS <= 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-zinc-500">
        Indexing… first scene usually appears 3–6 minutes after Start.
      </div>
    );
  }

  const total = Math.max(1, Math.ceil(videoLengthS / SCENE_WINDOW_S));
  const indexed = Math.max(0, Math.min(total, indexedScenes ?? 0));
  const elapsed = Math.max(1, now - startedAt);
  const pct = Math.min(100, Math.round((indexed / total) * 100));

  // Football-themed status line. Rotates every ~8s so the user has time to
  // read each phrase before it changes. Pre-first-batch we cycle through
  // "kick-off" phrases; once the worker is producing scenes we switch to
  // "mid-game" phrases.
  const phrases = indexed === 0 ? KICKOFF_PHRASES : MID_PHRASES;
  const phrase = phrases[Math.floor(now / 8) % phrases.length];
  // Animated dots — '.', '..', '...' on a 1Hz cycle.
  const dots = ".".repeat((Math.floor(now) % 3) + 1);

  // Subtitle: only render an ETA when we have real throughput. Pre-first-
  // batch we stay silent — no pessimistic "waiting…" copy.
  let etaLine = "";
  if (indexed > 0) {
    const rate = indexed / elapsed;
    const remaining = (total - indexed) / Math.max(rate, 0.0001);
    etaLine = fmtRemaining(remaining);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-10 text-center">
      <div className="mb-2 text-sm font-medium text-zinc-200">
        {phrase}
        <span className="ml-0.5 inline-block w-4 text-left text-zinc-400">{dots}</span>
      </div>
      {/* Render the progress bar only once at least one scene has come
          back — an empty 0% bar reads as "broken" rather than "starting". */}
      {indexed > 0 && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-[#EC5B16] transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {etaLine && (
        <div className="mt-3 text-[11px] text-zinc-500">{etaLine}</div>
      )}
      <div className="mt-3 text-[10px] uppercase tracking-wider text-zinc-600">
        Live ingest from VideoDB · events stream in as soon as the classifier locks on
      </div>
    </div>
  );
}
