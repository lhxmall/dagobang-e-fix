/**
 * @deprecated Import from @/utils/mutilWindowTokenInfo instead.
 * Kept as a thin re-export so existing imports keep working.
 */
export {
  resolveMutilWindowDirectQuote as resolveGmgnTokenQuoteCounterpartyQuote,
  resolveMutilWindowLineageHop,
  resolveMutilWindowLineagePrefetchQuote as resolveGmgnLineagePrefetchQuote,
  type MutilWindowLineageHop,
  type MutilWindowTokenRow,
} from '@/utils/mutilWindowTokenInfo';

import {
  resolveMutilWindowDirectQuote,
  resolveMutilWindowLineageHop,
  resolveMutilWindowLineagePrefetchQuote,
  type MutilWindowTokenRow,
} from '@/utils/mutilWindowTokenInfo';

/** @deprecated Use resolveMutilWindowLineageHop — returns quote only for legacy callers. */
export function resolveGmgnTokenQuoteCounterparty(
  chainId: number,
  selfAddress: string,
  item: MutilWindowTokenRow | null | undefined,
): { quote: string; source: 'pool_quote' | 'tpool_quote' } | null {
  const hop = resolveMutilWindowLineageHop(chainId, selfAddress, item);
  if (!hop) return null;
  return { quote: hop.quote, source: hop.source };
}

export { resolveMutilWindowLineagePrefetchQuote as resolveGmgnLineagePrefetchQuote };
