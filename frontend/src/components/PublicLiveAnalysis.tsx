import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, Play, Search } from "lucide-react";

type Event = { start: number; end: number; eventType: string; team: string; confidence: number; summary: string };
type Job = {
  id: string; sourceUrl: string; mode: "football" | "describe"; status: "queued" | "running" | "completed" | "failed";
  stage: string; progress: number; videoId: string | null; streamUrl: string | null; highlightUrl: string | null;
  events: Event[]; error: string | null; createdAt: string;
};
type AskResult = { answer: string; sources: Array<{ start: number; end: number; text: string; streamUrl?: string }> };
type JobPayload = { job: Job; questions?: Array<{ answer: string; sources: AskResult["sources"] }> };

const STORAGE_KEY = "datacaster_public_job";

function playerUrl(streamUrl: string): string {
  return `https://console.videodb.io/player?url=${encodeURIComponent(streamUrl)}`;
}

function timecode(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export function PublicLiveAnalysis() {
  const [sourceUrl, setSourceUrl] = useState("");
  const [mode, setMode] = useState<"football" | "describe">("football");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    fetch(`/api/jobs/${encodeURIComponent(saved)}`).then(async (response) => {
      if (!response.ok) throw new Error("expired");
      return response.json();
    }).then((data: JobPayload) => {
      setJob(data.job);
      const latest = data.questions?.at(-1);
      if (latest) setAskResult({ answer: latest.answer, sources: latest.sources });
    }).catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  const jobId = job?.id;
  const jobStatus = job?.status;
  useEffect(() => {
    if (!jobId || jobStatus === "completed" || jobStatus === "failed") return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const data = await response.json();
        if (response.ok) setJob(data.job);
      } catch { /* the next poll retries */ }
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

  const playback = job?.highlightUrl || job?.streamUrl;
  const sortedEvents = useMemo(() => [...(job?.events || [])].sort((a, b) => a.start - b.start), [job?.events]);

  async function startRun(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setAskResult(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl, mode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start analysis");
      setJob(data.job);
      localStorage.setItem(STORAGE_KEY, data.job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start analysis");
    } finally { setBusy(false); }
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!job) return;
    setAskBusy(true); setError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "VideoDB Ask failed");
      setAskResult(data); setQuestion("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "VideoDB Ask failed"); }
    finally { setAskBusy(false); }
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10 text-zinc-100 sm:px-6">
      <section className="mx-auto max-w-6xl">
        <p className="text-xs font-medium uppercase tracking-[0.22em] text-[#EC5B16]">New VideoDB analysis</p>
        <h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-tight sm:text-5xl">Run DataCaster on your own match recording.</h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-zinc-400">
          Submit a public HTTPS video or YouTube URL. A durable Vercel worker uploads it to VideoDB, indexes visible moments, builds a playable review, and enables evidence-backed Ask.
        </p>

        <form onSubmit={startRun} className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
          <label className="block text-sm font-medium text-zinc-100" htmlFor="source-url">Public video URL</label>
          <div className="mt-2 flex flex-col gap-3 lg:flex-row">
            <input id="source-url" type="url" required value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..." className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm outline-none focus:border-[#EC5B16]" />
            <select aria-label="Analysis mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm">
              <option value="football">Football events</option><option value="describe">General action review</option>
            </select>
            <button disabled={busy || Boolean(job && ["queued", "running"].includes(job.status))}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#EC5B16] px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Start new run
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <button type="button" className="text-orange-300 underline underline-offset-2" onClick={() => { setSourceUrl("https://www.youtube.com/watch?v=DP4epIVQOCk"); setMode("football"); }}>Use the public football demo source</button>
            <span>15-minute maximum · 3 runs/browser/day · results persist across refreshes</span>
          </div>
        </form>

        {error && <div role="alert" className="mt-5 flex gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="h-5 w-5 shrink-0" />{error}</div>}

        {job && (
          <section className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)]">
            <article className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div><p className="text-xs uppercase tracking-[0.16em] text-orange-300">Run {job.id.slice(0, 8)}</p><h2 className="mt-2 text-xl font-semibold">{job.stage}</h2></div>
                {job.status === "completed" ? <CheckCircle2 className="h-6 w-6 text-emerald-400" /> : job.status !== "failed" ? <LoaderCircle className="h-6 w-6 animate-spin text-orange-300" /> : <AlertTriangle className="h-6 w-6 text-red-400" />}
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full bg-[#EC5B16] transition-all" style={{ width: `${job.progress}%` }} /></div>
              <p className="mt-2 text-xs text-zinc-500">{job.progress}% · durable job state is stored in Azure Postgres</p>
              {job.error && <p className="mt-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{job.error}</p>}
              {playback && <div className="mt-5 aspect-video overflow-hidden rounded-xl border border-zinc-800 bg-black"><iframe className="h-full w-full" src={playerUrl(playback)} title="DataCaster VideoDB analysis playback" allow="autoplay; fullscreen" allowFullScreen /></div>}
              {job.streamUrl && job.highlightUrl && job.streamUrl !== job.highlightUrl && <a className="mt-3 inline-block text-xs text-orange-300 underline underline-offset-2" href={playerUrl(job.streamUrl)} target="_blank" rel="noreferrer">Open full source stream</a>}
            </article>

            <article className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6">
              <p className="text-xs uppercase tracking-[0.16em] text-orange-300">Detected timeline</p>
              {job.status === "completed" && !sortedEvents.length && <p className="mt-4 text-sm leading-6 text-zinc-400">VideoDB completed the review but found no qualifying {job.mode === "football" ? "football" : "action"} event. The source remains playable above.</p>}
              <ol className="mt-4 grid max-h-[420px] gap-2 overflow-auto">
                {sortedEvents.map((item, index) => <li key={`${item.start}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <div className="flex items-center justify-between gap-3"><strong className="text-sm capitalize">{item.eventType.replaceAll("_", " ")}</strong><span className="font-mono text-xs text-orange-300">{timecode(item.start)}</span></div>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">{item.summary}</p>
                </li>)}
              </ol>
            </article>
          </section>
        )}

        {job?.status === "completed" && (
          <section className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 sm:p-6">
            <div className="flex items-center gap-2"><Search className="h-5 w-5 text-emerald-400" /><h2 className="text-lg font-semibold">Ask this run</h2></div>
            <form onSubmit={ask} className="mt-4 flex flex-col gap-3 sm:flex-row"><input required minLength={4} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What were the most important visible moments?" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm" /><button disabled={askBusy} className="rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-50">{askBusy ? "Asking VideoDB…" : "Ask VideoDB"}</button></form>
            <p className="mt-2 text-xs text-zinc-500">Questions call VideoDB against this newly indexed asset. Public limit: 5 per run.</p>
            {askResult && <div className="mt-5 rounded-xl border border-emerald-500/20 bg-zinc-950/50 p-4"><p className="text-sm leading-6 text-zinc-200">{askResult.answer}</p>{askResult.sources.length > 0 && <ul className="mt-3 grid gap-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">{askResult.sources.map((source, index) => <li key={index}>[{timecode(source.start)}–{timecode(source.end)}] {source.text}</li>)}</ul>}</div>}
          </section>
        )}
      </section>
    </main>
  );
}
