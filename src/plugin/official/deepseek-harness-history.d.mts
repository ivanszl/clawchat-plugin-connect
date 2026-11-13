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
