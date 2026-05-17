import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";

interface CoachStep {
  title: string;
  body: string;
}

const STEPS: CoachStep[] = [
  {
    title: "Live match plays here",
    body: "The match plays here. Click any event in the timeline to scrub to that moment.",
  },
  {
    title: "Events appear in the timeline",
    body: "Every goal, shot, save, card, and corner appears here within ~30 seconds of going live, with confidence scores.",
  },
  {
    title: "Ask anything",
    body: "Ask plain-English questions: \"who scored the first goal?\", \"show me every save\", \"were there any cards?\"",
  },
];

interface Props {
  active: boolean;
  step: number;
  onNext: () => void;
  onSkip: () => void;
}

export function Coachmarks({ active, step, onNext, onSkip }: Props) {
  if (!active || step >= STEPS.length) return null;
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <>
      {/* Dimming overlay; click-through forwarded to onSkip */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onSkip} />

      {/* Bottom-right popover */}
      <div className="fixed bottom-6 right-6 z-50 w-[320px] rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>
          <button
            onClick={onSkip}
            className="text-zinc-500 hover:text-zinc-200"
            aria-label="Skip tour"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <h3 className="text-sm font-semibold text-zinc-100">{current.title}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-400">{current.body}</p>
        <div className="mt-3 flex justify-end gap-2">
          {!isLast && (
            <Button onClick={onSkip} variant="ghost" size="sm" className="h-7 text-xs">
              Skip
            </Button>
          )}
          <Button onClick={onNext} size="sm" className="h-7 text-xs">
            {isLast ? "Got it" : "Next"}
          </Button>
        </div>
        {/* Step dots */}
        <div className="mt-3 flex justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-amber-400" : "bg-zinc-700"}`}
            />
          ))}
        </div>
      </div>
    </>
  );
}
