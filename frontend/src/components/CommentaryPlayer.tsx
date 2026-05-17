import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { CommentaryItem } from "@/lib/types";
import { Mic, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Voice-availability state surfaced by GET /api/commentary/track.
interface VoiceStatus {
  available: boolean;
  consecutive_failures: number;
  backoff_remaining_s: number;
}

export function CommentaryPlayer({ trigger }: { trigger: number }) {
  const [items, setItems] = useState<CommentaryItem[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [currentlyPlayingId, setCurrentlyPlayingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.commentaryTrack(50);
        if (!alive) return;
        setItems(r.items);
        if (r.voice) setVoiceStatus(r.voice);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [trigger]);

  // Imperative play helper. Routes the VideoDB audio URL into the single
  // <audio> element. If a row has no audio_url (voice cap hit), the Play
  // button is hidden — we don't fall back to browser TTS because the user
  // explicitly asked for VideoDB voice only.
  const playItem = (item: CommentaryItem) => {
    if (!audioRef.current || !item.audio_url) return;
    playedRef.current.add(item.id);
    setCurrentlyPlayingId(item.id);
    if (audioRef.current.src !== item.audio_url) {
      audioRef.current.src = item.audio_url;
    }
    audioRef.current.play().catch(() => { /* user gesture required */ });
  };

  const pauseCurrent = () => {
    audioRef.current?.pause();
    setCurrentlyPlayingId(null);
  };

  const stopAll = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setCurrentlyPlayingId(null);
  };

  // Autoplay: when on, queue the next unplayed item that has VideoDB audio.
  // Items without audio (voice cap hit) are skipped — they still appear in
  // the list as text-only cards, just not in the audio queue.
  useEffect(() => {
    if (!autoplay) return;
    if (currentlyPlayingId !== null) return;
    if (items.length === 0) return;
    const next = items.find(i => i.audio_url && !playedRef.current.has(i.id));
    if (!next) return;
    playItem(next);
  }, [items, autoplay, currentlyPlayingId]);

  const onEnded = () => {
    setCurrentlyPlayingId(null);
  };

  // VideoDB voice quota state. When `available` is false, every commentary
  // row is text-only and a banner shows when audio will resume.
  const voiceUnavailable = voiceStatus && !voiceStatus.available;
  const backoffMin = voiceStatus
    ? Math.max(0, Math.ceil(voiceStatus.backoff_remaining_s / 60))
    : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-0.5 border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-zinc-400">
              Commentary track
            </span>
            <span className="rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400">
              {items.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoplay(!autoplay)}
              className={
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider transition " +
                (autoplay
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200")
              }
              title={autoplay ? "Autoplay is on — click for manual" : "Manual mode — click for autoplay"}
            >
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  (autoplay ? "bg-emerald-400 animate-pulse" : "bg-zinc-500")
                }
              />
              {autoplay ? "auto" : "manual"}
            </button>
            <button
              onClick={stopAll}
              disabled={currentlyPlayingId === null}
              className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:text-zinc-300"
              title="Stop playback"
            >
              <Square className="h-2.5 w-2.5" fill="currentColor" />
              stop
            </button>
          </div>
        </div>
        {voiceUnavailable && (
          <div className="text-[10px] text-amber-400">
            VideoDB voice cap reached — text-only commentary
            {backoffMin > 0 ? ` (retrying in ~${backoffMin}m)` : ""}
          </div>
        )}
      </header>
      <div className="border-b border-zinc-800 bg-zinc-950/60 px-3 py-2">
        <audio
          ref={audioRef}
          controls
          onEnded={onEnded}
          className="h-8 w-full"
        />
      </div>
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="divide-y divide-zinc-800/50">
          {items.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">
              no commentary yet
            </div>
          )}
          {items.map(c => {
            const isActive = c.id === currentlyPlayingId;
            const hasAudio = Boolean(c.audio_url);
            return (
              <div
                key={c.id}
                className={
                  "min-w-0 overflow-hidden px-3 py-2 border-l-2 transition " +
                  (isActive
                    ? "border-l-emerald-400 bg-emerald-500/5"
                    : "border-l-transparent")
                }
              >
                {isActive && (
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Now playing
                  </div>
                )}
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  {!hasAudio && (
                    <Mic
                      className="h-2.5 w-2.5 text-amber-400/70"
                      aria-label="Text-only — VideoDB voice cap reached"
                    />
                  )}
                  <span>{c.event_type ?? "event"}</span>
                  <span>·</span>
                  <span>{c.voice_style}</span>
                  {!hasAudio && (
                    <span className="ml-auto text-[10px] text-amber-400/60">text-only</span>
                  )}
                </div>
                <div className="mt-0.5 break-words text-xs text-zinc-300">{c.text}</div>
                {hasAudio && (
                  <div className="mt-1.5 flex justify-end">
                    <button
                      onClick={() => (isActive ? pauseCurrent() : playItem(c))}
                      className={
                        "flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition " +
                        (isActive
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100")
                      }
                    >
                      {isActive ? (
                        <>
                          <Pause className="h-2.5 w-2.5" fill="currentColor" />
                          Pause
                        </>
                      ) : (
                        <>
                          <Play className="h-2.5 w-2.5" fill="currentColor" />
                          Play
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
