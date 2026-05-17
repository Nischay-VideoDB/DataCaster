import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { humanize } from "@/lib/errors";
import { Mic, PlayCircle, Sparkles, Target } from "lucide-react";
import { useState } from "react";

const SAMPLE_FOOTBALL = {
  source_type: "url" as const,
  source: "rtsp://samples.rts.videodb.io:8554/crib",
  // TODO: replace with a public football RTSP feed when one is verified.
};

interface Props {
  /** When true, render the overlay. Parent controls based on pipeline state +
   *  localStorage. */
  open: boolean;
  /** Called after the user dismisses (either via Try-the-demo success or
   *  Use-my-own-stream click). Parent should set localStorage and update its
   *  own state. */
  onDismiss: () => void;
  /** Optionally start the coachmarks tour after Try-the-demo succeeds. */
  onTourStart?: () => void;
}

export function Onboarding({ open, onDismiss, onTourStart }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const tryDemo = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.start(SAMPLE_FOOTBALL.source_type, SAMPLE_FOOTBALL.source);
      onDismiss();
      onTourStart?.();
    } catch (e) {
      const h = humanize(e);
      setErr(`${h.title} — ${h.body}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
      <div className="w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-950 p-8 shadow-2xl">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-400" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            DataCaster · v2
          </span>
        </div>

        <h1 className="text-2xl font-semibold text-zinc-100">
          Turn any live football feed into a searchable, narratable broadcast.
        </h1>

        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Drop in an RTSP, RTMP, or YouTube URL of a match. DataCaster extracts
          every goal, shot, save, and card with timestamps, generates
          broadcast-style commentary, and answers natural-language questions
          about what just happened.
        </p>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <Feature
            icon={<Target className="h-4 w-4" />}
            title="Real-time events"
            body="Goals, shots, saves, cards — extracted as the match unfolds."
          />
          <Feature
            icon={<PlayCircle className="h-4 w-4" />}
            title="Click to replay"
            body="Every event scrubs the player and auto-narrates."
          />
          <Feature
            icon={<Mic className="h-4 w-4" />}
            title="Ask anything"
            body="Plain-English match Q&A with timestamped citations."
          />
        </div>

        {err && (
          <div className="mt-4 rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onDismiss}
            className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-200 hover:underline"
          >
            Use my own stream
          </button>
          <Button onClick={tryDemo} disabled={busy} size="lg" className="px-6">
            {busy ? "Starting…" : "Try the demo"}
          </Button>
        </div>

        <p className="mt-4 text-[10px] text-zinc-600">
          Sample stream is a public RTSP feed; takes ~30s to start producing events.
        </p>
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center gap-1.5 text-zinc-300">
        {icon}
        <span className="text-[11px] font-medium">{title}</span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-500">{body}</p>
    </div>
  );
}
