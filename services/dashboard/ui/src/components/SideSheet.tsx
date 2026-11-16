import { Dialog, type DialogProps } from "./Dialog";

/** A modal `<dialog>` docked to the right edge (the unit test sheet); the same focus rules as `Dialog`. */
export function SideSheet(props: DialogProps) {
  return <Dialog {...props} className={`sheet${props.className ? ` ${props.className}` : ""}`} />;
}
