/** Stub: the adapter from the native addon to `BusTransport`. Implemented in LID Phase 6 (BUS-NAT-API-010, BUS-NAT-BLD-004). */
import type { decodeFrame as DecodeFrame, encodeFrame as EncodeFrame, tagProblem as TagProblem } from "./connector.js";
import type { TransportFactory } from "./transport.js";

export const createNativeTransport: TransportFactory = () => { throw new Error("not implemented"); };
export const encodeFrame: typeof EncodeFrame = () => { throw new Error("not implemented"); };
export const decodeFrame: typeof DecodeFrame = () => { throw new Error("not implemented"); };
export const tagProblem: typeof TagProblem = () => { throw new Error("not implemented"); };
