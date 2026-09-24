import type { GmgnQuoteLineageEntry } from '@/types/extention';

/**
 * Page-side (content-script) GMGN quote-lineage store.
 *
 * The GMGN /mutil_window_token_info endpoint can only be fetched from the page
 * main world (CORS + GMGN auth cookies). prewarm resolves a token's quote
 * lineage there and seeds the background cache via prewarmTurbo, but that
 * background cache is memory-only with a short TTL and does not survive SW
 * restarts. Limit orders, however, may execute hours later — possibly after a
 * SW restart — for a token that is no longer on the page.
 *
 * To make limit-order execution use the authoritative GMGN lineage, the lineage
 * resolved at prewarm time is also stashed here (page-session memory, 24h TTL)
 * so limit-order creation sites can attach it to the order. The executor
 * re-seeds from that snapshot only when it still matches fresh tokenInfo.
 * After inner→outer graduation the snapshot is discarded and re-walked via a
 * GMGN page tab.
 */

const TTL_MS = 24 * 60 * 60_000;

type Entry = { ts: number; value: GmgnQuoteLineageEntry[] | null };

const store = new Map<string, Entry>();

function key(chainId: number, token: string): string {
  return `${chainId}:${String(token || '').trim().toLowerCase()}`;
}

export function setGmgnLineage(
  chainId: number,
  token: string,
  lineage: GmgnQuoteLineageEntry[] | null,
): void {
  if (!token) return;
  store.set(key(chainId, token), { ts: Date.now(), value: lineage });
}

export function getGmgnLineage(
  chainId: number,
  token: string,
): GmgnQuoteLineageEntry[] | null {
  const k = key(chainId, token);
  const entry = store.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts >= TTL_MS) {
    store.delete(k);
    return null;
  }
  return entry.value;
}
