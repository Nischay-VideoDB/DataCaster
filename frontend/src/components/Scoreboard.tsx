import { useStats, usePipelineState } from "@/lib/api";
import { useEffect, useState } from "react";

interface Props {
  className?: string;
}

// Hash a string to a deterministic CSS oklch color (jersey-ish hue).
function kitColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `oklch(58% 0.18 ${hue})`;
}

function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function Scoreboard({ className = "" }: Props) {
  const stats = useStats(3000);
  const pipeline = usePipelineState(5000);
  const counts = stats?.counts ?? {};

  // Derived counts. Backend doesn't reliably attribute goals to teams (the
  // `team` field is often "unknown"), so we surface a single GOALS tile
  // rather than fabricate a home/away split.
  const goals = counts.goal ?? 0;
  const shotsOn = counts.shot_on_target ?? 0;
  const shotsOff = counts.shot_off_target ?? 0;
  const saves = counts.save ?? 0;
  const cards = (counts.yellow_card ?? 0) + (counts.red_card ?? 0);
  const corners = counts.corner ?? 0;

  // Live elapsed timer (since pipeline.started_at, ticks each second).
  const startedAt = pipeline?.started_at ?? null;
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = startedAt ? now - startedAt : 0;
  const isLive = Boolean(pipeline?.rtstream_id);

  const homeColor = kitColor(pipeline?.rtstream_id ?? "home");
  const awayColor = kitColor((pipeline?.rtstream_id ?? "away") + ":away");

  return (
    <div
      className={`flex flex-col gap-1.5 border-y border-zinc-800 bg-zinc-950 px-4 py-3 ${className}`}
    >
      {/* Top row: crest · GOALS centerpiece · timer · crest */}
      <div className="flex items-center gap-4">
        <Crest color={homeColor} label="Home" />

        <div className="flex flex-1 items-center justify-center gap-6">
          <ScoreBlock label="Goals" value={goals} />
          <Divider />
          <TimerBlock elapsed={elapsed} live={isLive && Boolean(startedAt)} />
        </div>

        <Crest color={awayColor} label="Away" />
      </div>

      {/* Secondary stats row */}
      <div className="flex items-center justify-center gap-4 text-[11px] text-zinc-400">
        <SecondaryStat label="shots" value={`${shotsOn}/${shotsOff}`} />
        <SecondaryStat label="saves" value={saves} />
        <SecondaryStat label="cards" value={cards} />
        <SecondaryStat label="corners" value={corners} />
      </div>
    </div>
  );
}

function Crest({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="h-10 w-10 rounded-md border border-zinc-700 shadow-inner"
        style={{ background: color }}
        aria-label={`${label} crest`}
      />
      <span className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</span>
    </div>
  );
}

function ScoreBlock({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="mt-1 text-3xl font-bold tabular-nums text-zinc-100">{value}</span>
    </div>
  );
}

function TimerBlock({ elapsed, live }: { elapsed: number; live: boolean }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">Time</span>
      <div className="mt-1 flex items-center gap-1.5">
        {live && (
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            LIVE
          </span>
        )}
        <span className="font-mono text-xl tabular-nums text-emerald-400">
          {fmtClock(elapsed)}
        </span>
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-10 w-px bg-zinc-800" aria-hidden="true" />;
}

function SecondaryStat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}:</span>
      <span className="font-mono tabular-nums text-zinc-200">{value}</span>
    </span>
  );
}
