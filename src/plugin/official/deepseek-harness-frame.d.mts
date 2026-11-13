export const DSH_BRIDGE_MAX_FRAME_BYTES: number;
export interface EncodedBridgeFrame {
  encoded: string;
  degraded: null | { originalBytes: number; bytes: number; fields: number; placeholder: boolean };
}
export function encodeBridgeFrame(frame: unknown, limit?: number): EncodedBridgeFrame;
export const DSH_BRIDGE_HISTORY_PAGE_BYTES: number;
export interface HistoryPageParams {
  headerOnly?: boolean;
  lastTurns?: number;
  types?: string[];
  beforeSeq?: number;
  limit?: number;
  maxBytes?: number;
}
export function pageHistoryEvents<T extends { seq: number; type: string }>(
  events: readonly T[],
  params?: HistoryPageParams,
): { events: T[]; complete: boolean; nextBeforeSeq: number | null };
