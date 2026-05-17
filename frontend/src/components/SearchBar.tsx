import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { SearchShot } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useState } from "react";

interface Props {
  onResults: (shots: SearchShot[]) => void;
  /** Optional callback fired after every successful search (even when zero
   *  shots come back), so a parent can flip a `hasSearched` flag and surface
   *  the empty-state UI in `<SearchResults>`. */
  onSearched?: () => void;
}

export function SearchBar({ onResults, onSearched }: Props) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("visual");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.search(q, kind);
      onResults(r.shots);
      onSearched?.();
    } catch (e) {
      setErr(String(e));
      onResults([]);
      onSearched?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-zinc-800 px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wider text-zinc-400">
            Semantic search
          </span>
          <span className="text-[10px] text-zinc-500">
            Search across visual scenes, audio, and transcripts
          </span>
        </div>
        <Tabs value={kind} onValueChange={setKind}>
          <TabsList className="h-7 bg-zinc-900">
            <TabsTrigger value="visual" className="h-6 px-2 text-[11px]">
              visual
            </TabsTrigger>
            <TabsTrigger value="audio" className="h-6 px-2 text-[11px]">
              audio
            </TabsTrigger>
            <TabsTrigger value="transcript" className="h-6 px-2 text-[11px]">
              transcript
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
          placeholder='try: "shots from outside the box"'
          className="h-8 border-zinc-800 bg-zinc-950 text-xs placeholder:text-zinc-600"
        />
        <Button onClick={run} disabled={busy || !q.trim()} size="sm" className="h-8">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Search"}
        </Button>
      </div>
      {err && <div className="mt-1 text-xs text-red-400">{err}</div>}
    </div>
  );
}
