import { Dialog, type DialogProps } from "./Dialog";

/** A modal `<dialog>` docked to the right edge (the unit test sheet); the same focus rules as `Dialog`, and a backdrop click closes it. */
export function SideSheet({ backdropClose = true, ...props }: DialogProps) {
  return <Dialog {...props} backdropClose={backdropClose} className={`sheet${props.className ? ` ${props.className}` : ""}`} />;
}
