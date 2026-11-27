/**
 * The warning beside a key whose presentation marks it `sensitive`: the key decides where a credential or private data
 * goes, or who may reach the dashboard. It is a hint only; a save that changes the key is sent and gated like every other
 * save (DASH-SET-028).
 */
// @spec DASH-SET-028
export function SensitiveNote({ id }: { id?: string }) {
  return (
    <p className="note note-warn small" id={id}>
      This setting decides where a credential or private data goes, or who may reach the dashboard. Check the value before you save it.
    </p>
  );
}
