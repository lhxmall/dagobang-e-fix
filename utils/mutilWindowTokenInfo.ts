/**
 * GMGN /mutil_window_token_info row semantics — authoritative for quote lineage.
 * Do NOT use multi_token_info / multi_token_full_info fields (launch_quote_address,
 * tpool shallow USDT side pool, symbol-based BNC* templates) for routing hops.
 *
 * @see docs/mutil_window_token_info/*.json
 */
import { classifyDexPoolHint, isBytes32PoolId } from '@/utils/dexUtils';
import { isTradeRouteTerminalQuote } from '@/utils/tradeRouteTerminals';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type MutilWindowPool = {
  pool_address?: string | null;
  quote_address?: string | null;
  quote_symbol?: string | null;
  base_address?: string | null;
  exchange?: string | null;
  factory?: string | null;
};

export type MutilWindowTpool = {
  pool_address?: string | null;
  base_address?: string | null;
  quote_address?: string | null;
  exchange?: string | null;
  launch_type?: string | null;
};

export type MutilWindowTokenRow = {
  address?: string | null;
  symbol?: string | null;
  biggest_pool_address?: string | null;
  pool?: MutilWindowPool | null;
  tpool?: MutilWindowTpool | null;
};

export type MutilWindowLineageHopSource = 'pool_quote' | 'tpool_quote';

export type MutilWindowLineageHop = {
  quote: string;
  poolAddress: string;
  preferHint: 'v2' | 'v3' | 'v4' | null;
  source: MutilWindowLineageHopSource;
  /** mutil_window pool.factory — authoritative V2/V3 router factory for this hop. */
  poolFactory?: string | null;
  /** mutil_window pool.exchange — e.g. uniswap_v3, pancake_v2. */
  exchange?: string | null;
};

function normalizeAddress(value?: string | null): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(raw) || raw === ZERO_ADDRESS) return null;
  return raw;
}

/** Quote may be native (0x0). V4 pairs on RH use that for ETH, not WETH. */
function normalizeQuoteAddress(value?: string | null): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(raw)) return null;
  return raw;
}

function normalizePoolRef(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (isBytes32PoolId(raw)) return raw.toLowerCase();
  return normalizeAddress(raw);
}

function pickLineageHopPoolAddress(
  pool?: MutilWindowPool | null,
  tpool?: MutilWindowTpool | null,
  biggestPoolAddress?: string | null,
  source: MutilWindowLineageHopSource = 'pool_quote',
): string | null {
  if (source === 'tpool_quote') {
    const tpoolPool = normalizePoolRef(tpool?.pool_address);
    if (tpoolPool && !isBytes32PoolId(tpoolPool)) return tpoolPool;
    return tpoolPool;
  }
  const nested = normalizePoolRef(pool?.pool_address);
  if (nested && !isBytes32PoolId(nested)) return nested;
  const biggest = normalizePoolRef(biggestPoolAddress);
  if (biggest && !isBytes32PoolId(biggest)) return biggest;
  if (nested) return nested;
  return biggest;
}

/**
 * One direct-pair hop from a mutil_window row.
 *
 * pool.base === token → use pool.quote + pool.pool_address (terminal or not):
 * BNCB→BNC4, 4Stock→BNC4, 天才→GENIUS, GSTOCK→USDT, etc.
 *
 * Inner launchpads: tpool.base === token → tpool.quote + tpool.pool_address (章鱼币→BABAB).
 */
export function resolveMutilWindowLineageHop(
  chainId: number,
  tokenAddress: string,
  row: MutilWindowTokenRow | null | undefined,
): MutilWindowLineageHop | null {
  const self = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(self) || !row) return null;

  const pool = row.pool;
  const tpool = row.tpool;
  const poolBase = normalizeAddress(pool?.base_address) ?? normalizeAddress(pool?.address);
  const poolQuote = normalizeQuoteAddress(pool?.quote_address);

  if (poolBase === self && poolQuote && poolQuote !== self) {
    const poolAddress = pickLineageHopPoolAddress(pool, tpool, row.biggest_pool_address, 'pool_quote');
    if (!poolAddress) return null;
    return {
      quote: poolQuote,
      poolAddress,
      preferHint: classifyDexPoolHint({
        exchange: pool?.exchange,
        poolAddress,
      }),
      source: 'pool_quote',
      poolFactory: normalizeAddress(pool?.factory),
      exchange: String(pool?.exchange || '').trim() || null,
    };
  }

  const tpoolBase = normalizeAddress(tpool?.base_address);
  const tpoolQuote = normalizeQuoteAddress(tpool?.quote_address);
  if (tpoolBase === self && tpoolQuote && tpoolQuote !== self) {
    const poolAddress = pickLineageHopPoolAddress(pool, tpool, row.biggest_pool_address, 'tpool_quote');
    if (!poolAddress) return null;
    const exchange = String(tpool?.exchange || pool?.exchange || '').trim() || null;
    return {
      quote: tpoolQuote,
      poolAddress,
      preferHint: classifyDexPoolHint({
        exchange,
        poolAddress,
      }),
      source: 'tpool_quote',
      poolFactory: normalizeAddress(pool?.factory) || normalizeAddress(exchange),
      exchange,
    };
  }

  return null;
}

/** Direct quote for tokenInfo normalization — pool/tpool quote from mutil_window row. */
export function resolveMutilWindowDirectQuote(
  chainId: number,
  tokenAddress: string,
  row: MutilWindowTokenRow | null | undefined,
): string | null {
  return resolveMutilWindowLineageHop(chainId, tokenAddress, row)?.quote ?? null;
}

/** Next non-terminal token address to batch-prefetch in lineage walk. */
export function resolveMutilWindowLineagePrefetchQuote(
  chainId: number,
  tokenAddress: string,
  row: MutilWindowTokenRow | null | undefined,
): string | null {
  const hop = resolveMutilWindowLineageHop(chainId, tokenAddress, row);
  if (!hop?.quote || hop.quote === tokenAddress.toLowerCase()) return null;
  if (isTradeRouteTerminalQuote(chainId, hop.quote)) return null;
  return hop.quote;
}
