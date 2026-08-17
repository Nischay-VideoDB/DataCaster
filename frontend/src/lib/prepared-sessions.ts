export type PreparedTimelineEvent = {
  time: string;
  kind: string;
  detail: string;
};

export type PreparedSession = {
  id: string;
  label: string;
  title: string;
  summary: string;
  sourceLabel: string;
  sourceUrl: string;
  playbackUrl: string;
  playbackLabel: string;
  timeline: PreparedTimelineEvent[];
  question: string;
  answer: string;
  evidence: string[];
  reelNote: string;
};

/**
 * Public Vercel deployments deliberately use this static manifest instead of
 * reaching the SQLite-backed worker or VideoDB. Every entry is a prepared
 * client-demo fixture derived from the submitted walkthrough and demo script.
 */
export const PREPARED_SESSION_MANIFEST = {
  version: "2026-08-18",
  provenance:
    "Prepared client-side fixtures derived from the submitted DataCaster walkthrough and demo script. They are not fresh provider responses.",
  sessions: [
    {
      id: "matchday-two-goal-review",
      label: "Session 01",
      title: "Matchday 2 goal review",
      summary:
        "A frozen VOD scouting pass that demonstrates the event timeline and a selected attacking moment. It preserves the project’s match-analysis flow without submitting a new ingest or search job.",
      sourceLabel: "2022 FIFA World Cup Goals - Matchday 2 public VOD source",
      sourceUrl: "https://www.youtube.com/watch?v=DP4epIVQOCk",
      playbackUrl: "https://www.youtube-nocookie.com/embed/lR99z0Jel-4?start=22&end=50",
      playbackLabel: "Recorded DataCaster walkthrough - timeline filtering and selected-goal seek",
      timeline: [
        { time: "00:18", kind: "Goal", detail: "Prepared selected-goal moment from the submitted walkthrough." },
        { time: "00:42", kind: "Shot on target", detail: "Curated follow-up chance in the frozen scouting timeline." },
        { time: "01:06", kind: "Save", detail: "Prepared keeper-action review point." },
        { time: "01:48", kind: "Corner", detail: "Prepared set-piece context for the same session." },
      ],
      question: "Which prepared moment should the scout review first?",
      answer:
        "Start at [00:18]. The frozen session marks it as the selected goal-review moment, then keeps the follow-up chance and save in the same timeline for context.",
      evidence: ["[00:18] selected goal-review moment", "[00:42] prepared follow-up chance", "[01:06] prepared keeper-action review"],
      reelNote:
        "The local operator workflow can select these moments for a Timeline-built reel. This public session shows the recorded review state, not a newly composed export.",
    },
    {
      id: "matchday-two-discipline-review",
      label: "Session 02",
      title: "Matchday 2 discipline review",
      summary:
        "A separate frozen review session centered on the submitted Ask demonstration. The evidence stays visible beside the question so a client can inspect why the prepared answer is grounded.",
      sourceLabel: "2022 FIFA World Cup Goals - Matchday 2 public VOD source",
      sourceUrl: "https://www.youtube.com/watch?v=DP4epIVQOCk",
      playbackUrl: "https://www.youtube-nocookie.com/embed/lR99z0Jel-4?start=70&end=85",
      playbackLabel: "Recorded DataCaster walkthrough - evidence-backed Ask",
      timeline: [
        { time: "00:18", kind: "Red card", detail: "Prepared defender dismissal citation from the submitted Ask walkthrough." },
        { time: "02:10", kind: "Foul review", detail: "Curated context event retained with the discipline pass." },
        { time: "04:24", kind: "Red card", detail: "Prepared keeper dismissal citation from the submitted Ask walkthrough." },
        { time: "04:40", kind: "Restart", detail: "Curated post-dismissal context for the frozen session." },
      ],
      question: "Did anyone get a red card?",
      answer:
        "Yes - the prepared walkthrough cites two dismissals: [00:18] a defender after a last-man tackle, and [04:24] a keeper for handling outside the box.",
      evidence: ["[00:18] defender dismissal", "[04:24] keeper dismissal", "Recorded answer is reproduced from the submitted walkthrough"],
      reelNote:
        "The public view preserves the evidence chain only. New natural-language search stays in the documented local operator runtime.",
    },
    {
      id: "matchday-two-reel-handoff",
      label: "Session 03",
      title: "Matchday 2 highlight handoff",
      summary:
        "A finished handoff from a prepared timeline into the project’s vertical-reel step. It keeps the last-three-moments selection, reel proof, and human-readable recap together for a fast client walkthrough.",
      sourceLabel: "2022 FIFA World Cup Goals - Matchday 2 public VOD source",
      sourceUrl: "https://www.youtube.com/watch?v=DP4epIVQOCk",
      playbackUrl: "https://www.youtube-nocookie.com/embed/lR99z0Jel-4?start=50&end=70",
      playbackLabel: "Recorded DataCaster walkthrough - Timeline-composed vertical-reel step",
      timeline: [
        { time: "00:18", kind: "Goal", detail: "Prepared opening reel selection." },
        { time: "01:06", kind: "Save", detail: "Prepared defensive counterpoint for the reel." },
        { time: "04:24", kind: "Red card", detail: "Prepared high-impact closing moment." },
      ],
      question: "What does the prepared highlight handoff contain?",
      answer:
        "Three frozen moments - a goal, a save, and a high-impact discipline event - ready for the local Timeline composition step and a concise recap.",
      evidence: ["[00:18] goal selection", "[01:06] save selection", "[04:24] high-impact closing selection"],
      reelNote:
        "The player below is a recorded walkthrough of the project’s reel step. No standalone exported VideoDB reel URL is retained in this repository, so this deployment does not claim a new export.",
    },
  ] satisfies PreparedSession[],
} as const;
