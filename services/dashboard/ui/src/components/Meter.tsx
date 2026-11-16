/** The word for a strength percentage: Strong at 70% or more, Fading from 30% up to 70%, Weak below 30% (design: Memory strength). */
export function strengthWord(percent: number): "Strong" | "Fading" | "Weak" {
  return percent >= 70 ? "Strong" : percent >= 30 ? "Fading" : "Weak";
}

/**
 * A native `<meter>` with its value as text, "Strong · 90%": a word, then the percent, so the bar never carries the
 * meaning alone. `low`, `high` and `optimum` put the browser's good, fair and poor fill states at the word thresholds. The meter's accessible name repeats both for assistive technology.
 */
export function Meter({ label, percent, word }: { label: string; percent: number; word?: string }) {
  const p = Math.round(Math.min(100, Math.max(0, percent)));
  const w = word ?? strengthWord(p);
  return (
    <span className="meter">
      <meter min={0} max={100} low={30} high={69} optimum={100} value={p} aria-label={`${label}: ${w} ${p}%`} />
      <span className="meter-text">{`${w} · ${p}%`}</span>
    </span>
  );
}
