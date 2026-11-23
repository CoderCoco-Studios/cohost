/**
 * Head rotation shared by every consumer that turns the avatar's head angles into a bone rotation: the VMC driver and
 * the renderer page. Pure: no imports, no I/O, no clock, so the dashboard UI build can bundle it unchanged.
 */

/**
 * Pitch, yaw and roll in degrees to a unit quaternion `[x, y, z, w]`. `pitch` tips the head about +X, `yaw` turns it
 * about +Y and `roll` tilts it about +Z, in the left-handed space VMC receivers use. A zero rotation is the identity.
 */
// @spec SHARED-ROT-003
export function eulerToQuat(pitch: number, yaw: number, roll: number): [number, number, number, number] {
  const r = Math.PI / 180;
  const cy = Math.cos(yaw * r / 2), sy = Math.sin(yaw * r / 2);
  const cp = Math.cos(pitch * r / 2), sp = Math.sin(pitch * r / 2);
  const cr = Math.cos(roll * r / 2), sr = Math.sin(roll * r / 2);
  return [
    sp * cy * cr - cp * sy * sr,
    cp * sy * cr + sp * cy * sr,
    cp * cy * sr - sp * sy * cr,
    cp * cy * cr + sp * sy * sr,
  ];
}
