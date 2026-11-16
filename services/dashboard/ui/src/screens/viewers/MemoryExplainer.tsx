import { useId } from "react";
import type { MemoryFigures } from "./memory";

/**
 * What the strength percentage means, in words, above a viewer's notes: how firmly the co-host remembers a note, that it
 * fades with a half-life, rises when the topic comes up again, and decides which notes are used and when one is dropped or
 * demoted. The figures come from `brain.memory`; when they could not be read the sentences stay and the figures go
 * (DASH-VIEWERS-022).
 */
// @spec DASH-VIEWERS-022
export function MemoryExplainer({ figures: f }: { figures: MemoryFigures | null }) {
  const id = useId();
  return (
    <section className="explainer" aria-labelledby={id}>
      <h3 id={id}>What “memory strength” means</h3>
      <p>
        The percentage is how firmly the co-host remembers a note, from 0 to 100%. A new note starts at 100%.
      </p>
      <p>
        It fades with time, with a half-life.{" "}
        {f ? `A recent note loses half its strength every ${f.recentHalfLifeDays} days; a core note every ${f.coreHalfLifeDays} days.` : "A note loses half its strength every so often, sooner for a recent note than for a core one."}
      </p>
      <p>
        It jumps back up each time the viewer brings the topic up again{f ? `. After ${f.promoteMentions} mentions a recent note becomes a core note.` : ". Enough mentions turn a recent note into a core note."}
      </p>
      <p>
        It decides what gets used.{" "}
        {f
          ? `The co-host is given a viewer's strongest notes first, ${f.maxNotesPerViewer} at most. A recent note under ${f.dropBelow}% is forgotten; a core note under ${f.demoteBelow}% drops back to recent.`
          : "The co-host is given a viewer's strongest notes first. A recent note that fades too far is forgotten; a core note that fades too far drops back to recent."}
      </p>
      <p className="help">Strong is 70% or more, Fading is from 30% up to 70%, Weak is below 30%.</p>
    </section>
  );
}
