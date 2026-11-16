import { Dialog, type DialogProps } from "./Dialog";

/** A modal `<dialog>` docked to the right edge (the unit test sheet); the same focus rules and the same backdrop rule as `Dialog`: a backdrop click closes it only when `backdropClose` is set, which a sheet holding fields never does. */
export function SideSheet({ backdropClose = false, ...props }: DialogProps) {
  return <Dialog {...props} backdropClose={backdropClose} className={`sheet${props.className ? ` ${props.className}` : ""}`} />;
}
