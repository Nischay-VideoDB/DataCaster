import { Button } from "@/components/ui/button";
import { api, usePipelineState, useStats } from "@/lib/api";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StreamPanel } from "./StreamPanel";

export function HighlightReel() {
  const pipeline = usePipelineState(5000);
  const stats = useStats(5000);
  const [url, setUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Auto-fire compose() once per session if the pipeline has been running
  // long enough that highlights probably exist.
  const autoFiredRef = useRef(false);
  // Track event count at last compose to drive the "fresh data available"
  // glow on the Compose button.
  const lastComposedTotalRef = useRef<number>(0);

  const compose = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.highlightStream();
      setUrl(r.stream_url);
      setMode(r.mode);
      lastComposedTotalRef.current = stats?.total ?? 0;
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Auto-compose once when the pipeline has been running >60s. Idempotent
  // via a ref so HMR / re-renders / pipeline polls don't re-fire it.
  useEffect(() => {
    if (autoFiredRef.current) return;
    const startedAt = pipeline?.started_at;
    if (!startedAt) return;
    const elapsedSec = Math.floor(Date.now() / 1000) - startedAt;
    if (elapsedSec < 60) return;
    autoFiredRef.current = true;
    compose();
    // compose is stable (uses refs/setState only); pipeline drives the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.started_at]);

  // "Fresh data" glow: more than 5 new events have arrived since last compose.
  const total = stats?.total ?? 0;
  const hasFreshData = total > lastComposedTotalRef.current + 5;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-zinc-400">
            Highlight reel
          </span>
          {mode && (
            <span className="rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {mode}
            </span>
          )}
        </div>
        <Button
          onClick={compose}
          disabled={busy}
          size="sm"
          className={
            "h-7 text-[11px] transition " +
            (hasFreshData && !busy
              ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/50 hover:bg-emerald-500/30"
              : "")
          }
          title={hasFreshData ? "New events available — recompose" : "Compose highlight reel"}
        >
          {busy ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              composing…
            </span>
          ) : hasFreshData ? (
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Compose
            </span>
          ) : (
            "Compose"
          )}
        </Button>
      </header>
      <div className="flex flex-1 flex-col p-2">
        {busy && !url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
            <span>Composing highlight reel…</span>
          </div>
        ) : url ? (
          <div className="flex-1">
            <StreamPanel url={url} />
          </div>
        ) : mode === "none" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
            <div className="text-xs text-zinc-400">
              Highlights compose every ~60s once enough events are detected.
            </div>
            <div className="text-[11px] text-zinc-500">
              Check back in a moment.
            </div>
            <button
              onClick={compose}
              className="mt-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[10px] uppercase tracking-wider text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100"
            >
              Compose now
            </button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">
            press Compose after a few minutes of streaming
          </div>
        )}
        {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      </div>
    </div>
  );
}
