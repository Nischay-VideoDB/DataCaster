import { Coachmarks } from "@/components/Coachmarks";
import { EndSessionDialog } from "@/components/EndSessionDialog";
import { EventTimeline } from "@/components/EventTimeline";
import { ReelDialog } from "@/components/ReelDialog";
import { Onboarding } from "@/components/Onboarding";
import { OverflowMenu } from "@/components/OverflowMenu";
import { QueryPanel } from "@/components/QueryPanel";
import { ReplayScrubber } from "@/components/ReplayScrubber";
import { SourceControl } from "@/components/SourceControl";
import { StatusPill } from "@/components/StatusPill";
import { StreamPanel } from "@/components/StreamPanel";
import { api, mergeEvents, usePipelineState, useEventStream, useStats } from "@/lib/api";
import { humanize } from "@/lib/errors";
import { readShareLink } from "@/lib/share";
import type { DataCasterEvent } from "@/lib/types";
import { AlertTriangle, Radio, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ONBOARDING_KEY = "datacaster_seen";
const DEV_KEY = "datacaster_dev";

function urlHasDev(): boolean {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("dev") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const pipeline = usePipelineState(3000);
  const stats = useStats(3000);
  const [events, setEvents] = useState<DataCasterEvent[]>([]);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamUrlAutoSet, setStreamUrlAutoSet] = useState(false);
  // Tracks an in-flight /api/start (or /api/stop) so the header pill can
  // flip to CONNECTING the moment the user clicks Start, even before the
  // backend's `starting_at` makes it back through the next /api/health poll.
  const [sourceStarting, setSourceStarting] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  // Whether the End-session confirmation dialog is open. Replaces the
  // browser's native confirm() so the prompt matches the rest of the dark UI.
  const [endSessionDialogOpen, setEndSessionDialogOpen] = useState(false);
  // Sticky flag: a session has been started at least once this page load
  // and HAS NOT been ended yet via /api/end_session. Drives the End-session
  // button visibility — pressing Stop clears `pipeline.started_at` but
  // leaves the sandbox + cached events in place, so the user still needs
  // a way to fully wipe state. Cleared inside performEndSession().
  const [sessionLive, setSessionLive] = useState(false);
  // Reel result lifted from EventTimeline → ReelDialog. null = closed.
  const [reelResult, setReelResult] = useState<
    Awaited<ReturnType<typeof api.makeReel>> | null
  >(null);
  // Bumped whenever the user clicks End-session. Passed to QueryPanel via
  // sourceKey so it resets Ask/Search history; a sourceKey change is the
  // only way to wipe panels that don't directly read pipeline state.
  const [sessionResetKey, setSessionResetKey] = useState(0);
  // Backend reachability probe. Surfaced as a thin red strip under the header
  // when the API is unreachable for >1 consecutive failed health probe.
  const [backendError, setBackendError] = useState<string | null>(null);

  // Onboarding + tour state
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(() => {
    if (urlHasDev()) return false;
    try { return localStorage.getItem(ONBOARDING_KEY) !== "1"; } catch { return true; }
  });
  const [tourStep, setTourStep] = useState<number>(-1);

  // Dev panel toggle (controls visibility of debug chips)
  const [isDevMode, setIsDevMode] = useState<boolean>(() => {
    if (urlHasDev()) return true;
    try { return localStorage.getItem(DEV_KEY) === "1"; } catch { return false; }
  });

  // Hydrate event history from /api/events/history. Re-fires whenever the
  // pipeline's source identity changes (rtstream_id OR video_id), and also
  // every 5s while live in case events were classified faster than the SSE
  // connection could open. mergeEvents dedupes by id so this is idempotent.
  const sourceKey = pipeline?.rtstream_id ?? pipeline?.video_id ?? null;
  useEffect(() => {
    if (!sourceKey) return;
    let alive = true;
    const tick = () => {
      api.history(200)
        .then(r => { if (alive) setEvents(prev => {
          // Merge so an in-flight SSE event doesn't get clobbered.
          const byId = new Map<number, DataCasterEvent>(prev.map(e => [e.id, e]));
          for (const e of r.events) byId.set(e.id, e);
          return Array.from(byId.values()).sort((a, b) => b.unix_ts - a.unix_ts);
        }); })
        .catch(() => { /* ignore */ });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [sourceKey]);

  // Re-arm the auto-attach guard whenever the pipeline source changes
  // (new rtstream_id or video_id). Without this, a /api/end_session
  // followed by a fresh Start wouldn't auto-attach because performEndSession
  // intentionally leaves the guard set (see notes there).
  useEffect(() => {
    setStreamUrlAutoSet(false);
  }, [pipeline?.rtstream_id, pipeline?.video_id]);

  // Auto-attach the live HLS stream once on first sight per source.
  useEffect(() => {
    if (streamUrlAutoSet) return;
    const live = pipeline?.live_stream_url;
    if (live) {
      setStreamUrl(live);
      setStreamUrlAutoSet(true);
    }
  }, [pipeline?.live_stream_url, streamUrlAutoSet]);

  // Lazily request the live HLS URL ~30s after start. Fires for both live
  // RTStreams *and* VOD runs — gating only on rtstream_id meant the VOD
  // path's StreamPanel never received a URL.
  useEffect(() => {
    const sourceId = pipeline?.rtstream_id || pipeline?.video_id;
    if (!sourceId) return;
    if (pipeline?.live_stream_url) return;
    const t = setTimeout(() => {
      api.liveStream().catch(() => { /* retry on next pipeline tick */ });
    }, 30_000);
    return () => clearTimeout(t);
  }, [pipeline?.rtstream_id, pipeline?.video_id, pipeline?.live_stream_url]);

  // Live VOD scene-poll progress beacon. Updated every ~5s while
  // _start_vod_pipeline is indexing. Drives the snappy ETA bar in
  // EventTimeline; /api/health's vod_indexed_scenes is the slower truth.
  const [liveIndexedScenes, setLiveIndexedScenes] = useState<number | null>(null);

  // Single SSE connection — fans out to all consumers
  useEventStream((m) => {
    if (m.type === "event") setEvents(prev => mergeEvents(prev, m.event));
    if (m.type === "session_ended") {
      // Backend wiped the pipeline. Drop local state so the timeline
      // empties immediately instead of holding the cached rows from the
      // just-ended run.
      setEvents([]);
      setStreamUrl(null);
      setLiveIndexedScenes(null);
    }
    if (m.type === "resync") {
      // Same idea — events are about to be regenerated; clear stale rows.
      setEvents([]);
      setLiveIndexedScenes(null);
    }
    if (m.type === "vod_progress") {
      setLiveIndexedScenes(m.indexed);
    }
  });

  // Periodically probe /api/health so we can warn when the backend is down.
  // 5s interval matches the "Backend offline — retrying" UX.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        await api.health();
        if (alive) setBackendError(null);
      } catch (e) {
        if (alive) setBackendError(humanize(e).title);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Fallback for when StreamPanel isn't registered with the seeker (lib/playerControl).
  // Most timeline clicks now seek the existing video element directly, leaving
  // streamUrl unchanged. This handler runs only as a backup.
  const onSelectEvent = useCallback(async (e: DataCasterEvent) => {
    if (!pipeline?.rtstream_id && !pipeline?.video_id) return;
    try {
      const r = await api.search(e.event_type, "visual", 5);
      const closest = r.shots
        .filter(s => s.stream_url)
        .sort((a, b) =>
          Math.abs((a.start ?? 0) - e.unix_ts) - Math.abs((b.start ?? 0) - e.unix_ts),
        )[0];
      if (closest?.stream_url) setStreamUrl(closest.stream_url);
    } catch { /* ignore */ }
    api.generateCommentary(e.id, "excited").catch(() => { /* ignore */ });
  }, [pipeline?.rtstream_id]);

  // Deep-link: ?event= scrolls to and scrubs the matching event when it arrives
  const sharedLink = useMemo(() => readShareLink(), []);
  useEffect(() => {
    if (!sharedLink) return;
    const target = events.find(e => e.id === sharedLink.eventId);
    if (target) onSelectEvent(target);
  }, [sharedLink, events, onSelectEvent]);

  const dismissOnboarding = () => {
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* ignore */ }
    setOnboardingOpen(false);
  };

  const startTour = () => setTourStep(0);
  const nextTourStep = () => setTourStep(s => (s < 2 ? s + 1 : -1));
  const skipTour = () => setTourStep(-1);

  // Latch the sticky session flag the first time the backend reports an
  // active pipeline. Stays true through Stop (which clears started_at on
  // the backend) so the End-session button remains visible until the user
  // explicitly tears the sandbox down.
  useEffect(() => {
    if (pipeline?.started_at) setSessionLive(true);
  }, [pipeline?.started_at]);

  // Drop the SSE-pushed live counter whenever the pipeline goes idle.
  // /api/stop doesn't broadcast `session_ended`, so without this the
  // IndexingProgress bar would render stale "0 of ~330 — waiting for the
  // first batch" copy after a Stop while pipeline.video_length_s is still
  // briefly cached on /api/health. Resetting forces the empty state to
  // fall back to the "Click Start" copy until the next real Start.
  useEffect(() => {
    if (!pipeline?.started_at) setLiveIndexedScenes(null);
  }, [pipeline?.started_at]);

  // Single End-session handler. Stops the pipeline + wipes server-side
  // events / commentary / highlights via /api/end_session, then resets every
  // local React state so the UI shows a clean slate (no stale player URL,
  // no stale events, no stale Ask history). Bumping sessionResetKey forces
  // QueryPanel to discard its cached questions/answers.
  const performEndSession = useCallback(async () => {
    if (endingSession) return;
    setEndingSession(true);
    setSourceStarting(true);
    try {
      await api.endSession();
    } catch { /* surfaced via humanize on next health probe */ }
    finally {
      // Reset every locally-held bit of session state.
      setEvents([]);
      setStreamUrl(null);
      // Keep streamUrlAutoSet=true so the auto-attach effect doesn't re-pull
      // a stale live_stream_url before the next /api/health poll has caught
      // up to the server-side reset. If we flipped this to false here, the
      // player would re-grab the just-killed stream URL and the user would
      // need to click End-session twice. The next /api/start will reset the
      // guard via the source change.
      setStreamUrlAutoSet(true);
      setSessionResetKey(k => k + 1);
      setSourceStarting(false);
      setEndingSession(false);
      setEndSessionDialogOpen(false);
      // Sticky flag clears only on End-session, not on Stop.
      setSessionLive(false);
    }
  }, [endingSession]);

  // The button just opens the styled confirmation dialog; the dialog calls
  // performEndSession when the user clicks "End session".
  const openEndSessionDialog = () => setEndSessionDialogOpen(true);

  const toggleDevMode = () => {
    setIsDevMode(d => {
      const next = !d;
      try { localStorage.setItem(DEV_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const eventCount = stats?.total ?? events.length;

  // Pipeline-uptime clock. Drives the small chip on the top-right next to
  // the StatusPill. Re-ticks every second so the display reads truthful
  // seconds. Format is MM:SS for short sessions, H:MM:SS once we cross the
  // hour mark (broadcast runs can easily last 90+ min).
  const startedAt = pipeline?.started_at ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const elapsedMs = startedAt ? Math.max(0, now - startedAt * 1000) : 0;
  const elapsedH = Math.floor(elapsedMs / 3_600_000);
  const elapsedM = Math.floor((elapsedMs % 3_600_000) / 60_000);
  const elapsedS = Math.floor((elapsedMs % 60_000) / 1000);
  const matchClock = elapsedH > 0
    ? `${elapsedH}:${elapsedM.toString().padStart(2, "0")}:${elapsedS.toString().padStart(2, "0")}`
    : `${elapsedM.toString().padStart(2, "0")}:${elapsedS.toString().padStart(2, "0")}`;

  return (
    <div className="dark flex h-screen w-screen flex-col bg-zinc-950 text-zinc-200">
      {/* TOP BAR */}
      <header className="grid grid-cols-3 items-center border-b border-zinc-800 bg-zinc-950 px-4 py-2">
        {/* LEFT — wordmark + live status pill */}
        <div className="flex items-center gap-2">
          {/* Brand icon shares the orange (#EC5B16) of the VideoDB wordmark
              + the favicon, tying header / favicon / partner-mark together. */}
          <Radio className="h-5 w-5 text-[#EC5B16]" aria-hidden="true" />
          <span className="text-lg font-bold tracking-wide text-zinc-100">DataCaster</span>
          {pipeline?.started_at && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.15em] text-emerald-300">
              <span className="inline-block h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
              {pipeline?.source_type === "video" ? "Indexed" : "On Air"}
            </span>
          )}
        </div>

        {/* CENTRE — product tagline with the inline VideoDB wordmark.
            The PNG at /videodb-logo.png has a transparent background so it
            blends into the header instead of stamping a rectangle. */}
        <div className="flex items-center justify-center">
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            Football scout · automated using
            <img
              src="/videodb-logo.png"
              alt="VideoDB"
              className="h-3.5 w-auto select-none"
              draggable={false}
            />
          </span>
        </div>

        {/* RIGHT — status + end-session + menu */}
        <div className="flex items-center justify-end gap-2">
          <StatusPill pipeline={pipeline} eventCount={eventCount} busy={sourceStarting} />
          {/* Pipeline-uptime clock. Shown whenever the pipeline is connected
              (started_at set) — the format is HH:MM:SS once the session passes
              an hour, MM:SS otherwise. Sits next to the sandbox chip so the
              "what is this clock?" question has an obvious answer. */}
          {pipeline?.started_at && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[11px] tabular-nums text-emerald-300"
              title="Time since the session connected to VideoDB"
            >
              <span className="inline-block h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
              {matchClock}
            </span>
          )}
          {isDevMode && pipeline?.sandbox_id && (
            <span className="font-mono text-[10px] text-emerald-400">
              sandbox · {pipeline.sandbox_id.slice(0, 10)}
            </span>
          )}
          {isDevMode && pipeline?.rtstream_id && (
            <span className="font-mono text-[10px] text-zinc-500">
              rt · {pipeline.rtstream_id.slice(0, 10)}
            </span>
          )}
          {/* End-session control — visible from the first Start through the
              user's explicit End-session click (sticky across Stop). Pressing
              Stop clears `pipeline.started_at` on the backend but leaves the
              sandbox + cached events in place; the user still needs a way to
              fully wipe state, which is what this button does. */}
          {sessionLive && (
            <button
              type="button"
              onClick={openEndSessionDialog}
              disabled={endingSession}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium tracking-wide text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Stop pipeline and clear all session data (video, timeline, commentary, Ask/Search)"
            >
              <Trash2 className="h-3.5 w-3.5 text-zinc-400" />
              {endingSession ? "Ending…" : "End session"}
            </button>
          )}
          <OverflowMenu
            isDevMode={isDevMode}
            onToggleDevMode={toggleDevMode}
          />
        </div>
      </header>

      {/* GLOBAL ERROR BANNER */}
      {backendError && (
        <div className="flex items-center justify-center gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-1 text-[11px] text-red-200">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          <span>Backend offline — retrying</span>
        </div>
      )}

      {/* SOURCE BAR */}
      <div className="border-b border-zinc-800">
        <SourceControl onStartingChange={setSourceStarting} />
      </div>

      {/* MAIN GRID */}
      <main className="grid flex-1 grid-cols-12 grid-rows-1 overflow-hidden">
        {/* LEFT — stream + ask + search */}
        <section className="col-span-6 flex flex-col border-r border-zinc-800">
          <StreamPanel url={streamUrl} />
          <ReplayScrubber
            events={events}
            startedAt={pipeline?.started_at ?? null}
            onSelect={onSelectEvent}
          />
          <div className="flex-1 overflow-y-auto">
            <QueryPanel
              onPlay={setStreamUrl}
              sourceKey={`${pipeline?.video_id ?? pipeline?.rtstream_id ?? "idle"}:${sessionResetKey}`}
              startedAt={pipeline?.started_at ?? null}
            />
          </div>
        </section>

        {/* RIGHT — event timeline. Commentary track removed pending rework;
            timeline absorbs the freed column so it has more room. */}
        <section className="col-span-6 flex min-w-0 flex-col">
          <div className="flex-1 overflow-hidden">
            <EventTimeline
              events={events}
              startedAt={pipeline?.started_at ?? null}
              onSelect={onSelectEvent}
              mode={pipeline?.content_type === "describe" ? "describe" : "football"}
              indexedScenes={(() => {
                // SSE beacon is faster; /api/health is steadier. Use whichever
                // is higher when both are present, otherwise the available one.
                const a = pipeline?.vod_indexed_scenes;
                const b = liveIndexedScenes;
                if (a == null) return b ?? null;
                if (b == null) return a;
                return Math.max(a, b);
              })()}
              videoLengthS={pipeline?.video_length_s ?? null}
              pipelineActive={!!pipeline?.started_at}
              onResynced={() => setEvents([])}
              onReelComposed={setReelResult}
            />
          </div>
        </section>
      </main>

      <EndSessionDialog
        open={endSessionDialogOpen}
        busy={endingSession}
        onConfirm={performEndSession}
        onCancel={() => setEndSessionDialogOpen(false)}
      />
      <ReelDialog
        result={reelResult}
        onClose={() => setReelResult(null)}
      />
      <Onboarding
        open={onboardingOpen}
        onDismiss={dismissOnboarding}
        onTourStart={startTour}
      />
      <Coachmarks
        active={tourStep >= 0}
        step={Math.max(0, tourStep)}
        onNext={nextTourStep}
        onSkip={skipTour}
      />
    </div>
  );
}
