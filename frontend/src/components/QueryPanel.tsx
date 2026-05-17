import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { humanize } from "@/lib/errors";
import { seekPlayer } from "@/lib/playerControl";
import type { AskAnswer, SearchShot } from "@/lib/types";
import { Loader2, Play, RotateCcw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Optional fallback for environments where no <video> is registered with
   *  lib/playerControl (e.g. very early in pipeline lifecycle). When the
   *  inline seek fails we hand the shot's stream_url to the parent's
   *  StreamPanel as a one-shot clip. */
  onPlay: (url: string) => void;
  /** Stable id of the active source (video_id or rtstream_id). When this
   *  changes, all cached state is wiped so we never show answers / shots
   *  sourced from a previous pipeline run. */
  sourceKey?: string | null;
  /** pipeline.started_at (epoch seconds). Used to translate a Search shot's
   *  unix-timestamped `start` into an in-video offset for seekPlayer.
   *  Same math the Event Timeline uses. */
  startedAt?: number | null;
}

type QueryTab = "ask" | "search";
type SearchKind = "visual" | "audio" | "transcript";

/** VOD videos have ids prefixed `m-`; RTStream sessions have `rt-`. The
 *  audio search tab is RTStream-only — there's no first-class audio
 *  search for VOD in the VideoDB SDK. */
function searchKindsFor(sourceKey: string | null | undefined): SearchKind[] {
  if (!sourceKey) return ["visual", "audio", "transcript"];
  if (sourceKey.startsWith("m-")) return ["visual", "transcript"];
  return ["visual", "audio", "transcript"];
}

interface QueryError {
  title: string;
  body: string;
  /** Captured query string at the moment of failure, used for Retry. */
  query: string;
  /** Tab the error originated on; Retry returns to this tab + intent. */
  tab: QueryTab;
}

const ASK_SUGGESTIONS = [
  "Who scored?",
  "Show me every shot on target",
  "Did anyone get a card?",
  "What just happened?",
];

/**
 * Render a Search shot's `start` value as MM:SS in-video offset.
 * Same logic the Event Timeline uses: if start looks like a unix epoch
 * (>1B) we subtract `startedAt`; otherwise treat as offset directly. This
 * keeps the displayed timestamp consistent with the player after seek.
 */
function fmtClock(s: number | null, startedAt: number | null = null): string {
  if (s === null || s === undefined) return "--:--";
  let offset: number;
  if (startedAt && s >= startedAt) {
    offset = Math.max(0, Math.floor(s - startedAt));
  } else if (s > 1_000_000_000) {
    return "--:--";
  } else {
    offset = Math.max(0, Math.floor(s));
  }
  const h = Math.floor(offset / 3600);
  const m = Math.floor((offset % 3600) / 60);
  const sec = offset % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Search result `text` is the raw model output, which the model often wraps
 * in markdown code fences and our prompt asks to be JSON-shaped. Pretty-print
 * to "[event_type · team] summary" so the user reads a clean line instead of
 * a JSON blob. Falls back to the raw text (cleaned of fences) so unparseable
 * shapes still show *something*.
 */
function prettyShotText(raw: string | null | undefined): string {
  if (!raw) return "(no description)";
  let text = raw.trim();
  // Strip ```json … ``` and bare ``` … ``` fences.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  // Try parsing as JSON; if it's our schema, render the human bits.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const et = (parsed.event_type ?? "").toString().replace(/_/g, " ").trim();
      const team = (parsed.team ?? "").toString().trim();
      const summary = (parsed.summary ?? "").toString().trim();
      const tag = [et, team && team !== "unknown" ? team : ""]
        .filter(Boolean)
        .join(" · ");
      if (summary) return tag ? `[${tag}] ${summary}` : summary;
      if (tag) return `[${tag}]`;
    }
  } catch { /* fall through */ }
  return text.replace(/\s+/g, " ");
}

export function QueryPanel({ onPlay, sourceKey = null, startedAt = null }: Props) {
  const [tab, setTab] = useState<QueryTab>("ask");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [askHistory, setAskHistory] = useState<AskAnswer[]>([]);
  const [searchShots, setSearchShots] = useState<SearchShot[]>([]);
  const [searchKind, setSearchKind] = useState<SearchKind>("visual");
  const [hasSearched, setHasSearched] = useState(false);
  const [err, setErr] = useState<QueryError | null>(null);
  // Cancel-flag for in-flight ask/search requests. Aborting the controller
  // doesn't stop the underlying fetch (api.ts doesn't accept signals yet),
  // but it lets a stale response know to drop itself silently.
  const abortRef = useRef<AbortController | null>(null);

  // Source change (different video / different rtstream / pipeline stopped)
  // invalidates everything — stale shots from the previous run would point
  // at a stream that's no longer active.
  useEffect(() => {
    setQ("");
    setAskHistory([]);
    setSearchShots([]);
    setHasSearched(false);
    setErr(null);
    abortRef.current?.abort();
    abortRef.current = null;
    // Coerce the active kind to one supported by the new source. VOD
    // sources don't expose audio search — switch to "visual" rather than
    // letting a stale `audio` selection 400 the next request.
    setSearchKind((prev) => {
      const allowed = searchKindsFor(sourceKey);
      return allowed.includes(prev) ? prev : allowed[0];
    });
  }, [sourceKey]);

  const availableKinds = searchKindsFor(sourceKey);

  async function runAsk(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setErr(null);
    try {
      const a = await api.ask(trimmed, 6);
      if (controller.signal.aborted) return;
      setAskHistory(prev => [a, ...prev].slice(0, 5));
      setQ("");
    } catch (e) {
      if (controller.signal.aborted) return;
      const h = humanize(e);
      setErr({ title: h.title, body: h.body, query: trimmed, tab: "ask" });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function runSearch(text: string, kind: SearchKind) {
    const trimmed = text.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    setErr(null);
    try {
      const r = await api.search(trimmed, kind, 10);
      if (controller.signal.aborted) return;
      setSearchShots(r.shots);
      setHasSearched(true);
    } catch (e) {
      if (controller.signal.aborted) return;
      const h = humanize(e);
      setSearchShots([]);
      setHasSearched(true);
      setErr({ title: h.title, body: h.body, query: trimmed, tab: "search" });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  const submit = () => {
    if (tab === "ask") runAsk(q);
    else runSearch(q, searchKind);
  };

  /**
   * Translate a Search shot's `start` value into an in-video seek and call
   * the registered player. Mirrors EventTimeline.handleEventClick: if the
   * shot's start is a unix epoch (>1B) and we have `startedAt`, the
   * in-video offset is `start - startedAt`; otherwise treat `start` as the
   * offset directly (RTStream / fallback). Falls back to the parent's
   * StreamPanel if no player is registered yet.
   */
  const seekShot = (shot: SearchShot) => {
    if (!shot.start && shot.start !== 0) {
      if (shot.stream_url) onPlay(shot.stream_url);
      return;
    }
    const raw = shot.start;
    let offset: number;
    if (startedAt && raw >= startedAt) {
      offset = Math.max(0, raw - startedAt);
    } else if (raw > 1_000_000_000) {
      // Epoch-shaped without a known start — bail to the clip URL.
      if (shot.stream_url) onPlay(shot.stream_url);
      return;
    } else {
      offset = Math.max(0, raw);
    }
    const ok = seekPlayer(offset);
    if (!ok && shot.stream_url) onPlay(shot.stream_url);
  };

  const retry = () => {
    if (!err) return;
    if (err.tab === "ask") runAsk(err.query);
    else runSearch(err.query, searchKind);
  };

  const placeholder = tab === "ask"
    ? "Ask anything about what's happened…"
    : 'try: "shots from outside the box"';

  const subtitle = tab === "ask"
    ? "Plain-English questions answered with timestamped evidence."
    : "Find specific moments by keyword across visual, audio, and transcripts.";

  const inFlightLabel = tab === "ask"
    ? "Asking DataCaster… (this can take ~10s)"
    : "Searching indexed scenes…";

  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as QueryTab);
          setErr(null);
        }}
      >
        {/* Tabs span the full panel width with subtitle centered below.
            Each trigger is flex-1 so Ask + Search split the row 50/50,
            no leftover empty gutter. */}
        <div className="flex flex-col gap-1.5">
          <TabsList className="h-9 w-full bg-zinc-900 p-1">
            <TabsTrigger
              value="ask"
              className="h-7 flex-1 text-[12px] font-medium tracking-wide"
            >
              Ask
            </TabsTrigger>
            <TabsTrigger
              value="search"
              className="h-7 flex-1 text-[12px] font-medium tracking-wide"
            >
              Search
            </TabsTrigger>
          </TabsList>
          <div className="text-center text-[11px] text-zinc-500">
            {subtitle}
          </div>
        </div>

        {/* Shared input row — same width/height regardless of tab. */}
        <div className="mt-2 flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={placeholder}
            className="h-8 border-zinc-800 bg-zinc-950 text-sm placeholder:text-zinc-600"
          />
          <Button
            onClick={submit}
            disabled={busy || !q.trim()}
            size="sm"
            className="h-8"
          >
            {busy
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : (tab === "ask" ? "Ask" : "Search")}
          </Button>
        </div>

        {/* Persistent in-flight pill. Surfaces ~10s LLM latency for Ask and
            shorter index-search latency for Search, so the user knows we're
            actually doing something. */}
        {busy && (
          <div className="mt-2 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-[11px] text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
            <span>{inFlightLabel}</span>
          </div>
        )}

        {/* Shared error banner with Retry. */}
        {err && (
          <div className="mt-2 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-2">
            <div className="flex-1">
              <div className="text-[11px] font-medium text-red-300">{err.title}</div>
              <div className="mt-0.5 text-[11px] text-red-200/80">{err.body}</div>
            </div>
            <button
              onClick={retry}
              className="flex shrink-0 items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] uppercase tracking-wider text-red-200 transition hover:bg-red-500/20"
              title={`Retry: ${err.query}`}
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}

        {/* ──────────── ASK ──────────── */}
        <TabsContent value="ask" className="mt-2">
          {askHistory.length === 0 && !err && !busy && (
            <div className="flex flex-wrap gap-1.5">
              {ASK_SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => { setQ(s); runAsk(s); }}
                  className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {askHistory.map((h, i) => {
            const hasAnswer = !!h.answer && h.answer.trim().length > 0;
            return (
              <div
                key={i}
                className="mt-3 rounded border border-zinc-800 border-l-2 border-l-emerald-400 bg-zinc-900 p-3"
              >
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {h.query}
                </div>
                {hasAnswer ? (
                  <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-200">
                    {h.answer}
                  </p>
                ) : (
                  // The backend now refuses to fall back to raw evidence —
                  // an empty answer here means the search itself returned
                  // zero matches. (LLM failures are surfaced via the err
                  // banner above instead of as silent empty cards.)
                  <p className="text-sm text-zinc-400">
                    No matching evidence in the indexed timeline.
                  </p>
                )}
              </div>
            );
          })}
        </TabsContent>

        {/* ──────────── SEARCH ──────────── */}
        <TabsContent value="search" className="mt-2">
          {/* Kind selector — visual / audio / transcript. Nested Tabs to
              match the existing SearchBar aesthetic. */}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Index
            </span>
            <Tabs
              value={searchKind}
              onValueChange={(v) => {
                // Clear results from the previous index so the user
                // doesn't see stale visual hits while looking at the
                // transcript tab and vice versa. Re-running the same
                // query against the new index is one click away.
                setSearchKind(v as SearchKind);
                setSearchShots([]);
                setHasSearched(false);
                setErr(null);
              }}
            >
              <TabsList className="h-7 bg-zinc-900">
                {availableKinds.map((k) => (
                  <TabsTrigger key={k} value={k} className="h-6 px-2 text-[11px]">
                    {k}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {hasSearched && searchShots.length === 0 && !busy && !err && (
            <div className="py-4 text-center">
              <Search className="mx-auto mb-1.5 h-4 w-4 text-zinc-600" />
              <div className="text-xs text-zinc-400">No matching moments</div>
              <div className="mt-0.5 text-[10px] text-zinc-500">
                Try a broader term like &ldquo;goal&rdquo;, &ldquo;save&rdquo;, or &ldquo;card&rdquo;
              </div>
            </div>
          )}

          {searchShots.length > 0 && (
            <>
              <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                {searchShots.length} result{searchShots.length === 1 ? "" : "s"}
              </div>
              {/* Layout depends on the active index:
                  - transcript rows are full sentences from the spoken-word
                    index → wrap as a justified paragraph so the user can
                    read without horizontal scrolling.
                  - visual / audio rows are short structured summaries →
                    keep the compact single-line look from the original
                    Event-Timeline-style row. */}
              <div className="space-y-1.5">
                {searchShots.map((s, i) => {
                  const summary = prettyShotText(s.text);
                  const ts = fmtClock(s.start ?? null, startedAt);
                  const score = Math.round((s.score ?? 0) * 100);
                  if (searchKind === "transcript") {
                    return (
                      <div
                        key={i}
                        role="button"
                        tabIndex={0}
                        onClick={() => seekShot(s)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") seekShot(s);
                        }}
                        className="group cursor-pointer rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 transition hover:border-zinc-700 hover:bg-zinc-900"
                        title="Click to seek the player to this moment"
                      >
                        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-500">
                          <Play className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                          <span className="font-mono tabular-nums">{ts}</span>
                          <span className="ml-auto font-mono tabular-nums">{score}%</span>
                        </div>
                        <p className="whitespace-normal break-words text-justify text-[12px] leading-relaxed text-zinc-200 hyphens-auto">
                          {summary}
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      onClick={() => seekShot(s)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") seekShot(s);
                      }}
                      className="group flex cursor-pointer items-center gap-3 rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 transition hover:border-zinc-700 hover:bg-zinc-900"
                      title={summary}
                    >
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                        {ts}
                      </span>
                      <span className="line-clamp-2 flex-1 text-[11px] text-zinc-300">
                        {summary}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                        {score}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
