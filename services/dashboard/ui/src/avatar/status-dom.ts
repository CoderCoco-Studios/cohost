// Shows the preview's status line as text (DASH-AVP-035). The only DOM code of the pure layer: it writes text and never markup.

/** Sets the line as plain text and shows it; `null` hides the element and clears it. */
// @spec DASH-AVP-035
export function showStatusLine(el: HTMLElement, text: string | null): void {
  if (text === null) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
}
