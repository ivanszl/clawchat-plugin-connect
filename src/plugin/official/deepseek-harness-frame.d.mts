export interface EncodedBridgeFrame {
  encoded: string;
  degraded: null | { originalBytes: number; bytes: number; fields: number; placeholder: boolean };
}
export function encodeBridgeFrame(frame: unknown, limit: number): EncodedBridgeFrame;
