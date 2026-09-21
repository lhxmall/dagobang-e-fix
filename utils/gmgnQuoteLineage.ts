import {
  isEvmInnerLaunchpadToken,
  needsGmgnQuoteLineageWalk,
  resolveEvmGmgnDirectQuoteToken,
  supportsGmgnMutilWindowLineageChain,
} from '@/utils/bscTradeRoutePolicy';
import GmgnAPI, { type GmgnPageFetchRequest } from '@/hooks/GmgnAPI';
import type { GmgnQuoteLineageEntry } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { isBytes32PoolId } from '@/utils/dexUtils'; // pickGmgnPrimaryPoolAddress
import {
  resolveMutilWindowLineageHop,
  resolveMutilWindowLineagePrefetchQuote,
  type MutilWindowTokenRow,
} from '@/utils/mutilWindowTokenInfo';
import { isTradeRouteTerminalQuote } from '@/utils/tradeRouteTerminals';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_LINEAGE_DEPTH = 6;

function normalizeAddress(value?: string | null): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(raw) || raw === ZERO_ADDRESS) return null;
  return raw;
}

/** Primary pool ref for token-level classification (V4 vs V2/V3). */
export function pickGmgnPrimaryPoolAddress(item: {
  biggest_pool_address?: string | null;
  pool?: { pool_address?: string | null } | null;
} | null | undefined): string {
  const biggest = String(item?.biggest_pool_address || '').trim();
  const nested = String(item?.pool?.pool_address || '').trim();
  if (isBytes32PoolId(biggest)) return biggest;
  if (isBytes32PoolId(nested)) return nested;
  return biggest || nested;
}

function readKnownLineageHopPool(tokenInfo: TokenInfo): string | null {
  for (const candidate of [
    tokenInfo.pool_pair,
    tokenInfo.tpool_pool_address,
    tokenInfo.biggest_pool_address,
  ]) {
    const pool = normalizeAddress(candidate);
    if (pool) return pool;
  }
  return null;
}

export function isTokenCurrentlyInner(chainId: number, tokenInfo: TokenInfo): boolean {
  return isEvmInnerLaunchpadToken(chainId, tokenInfo);
}

/** @see needsGmgnQuoteLineageWalk — unified BSC/RH rule, all launchpads. */
export function shouldWalkGmgnQuoteLineage(chainId: number, tokenInfo?: TokenInfo | null): boolean {
  return needsGmgnQuoteLineageWalk(chainId, tokenInfo);
}

/**
 * Stored lineage is only safe to reuse when it still describes the current
 * outer market. Inner→outer graduation, a new biggest pool, or a different
 * non-terminal quote all make the snapshot expire.
 */
export function isGmgnQuoteLineageUsable(
  chainId: number,
  tokenInfo: TokenInfo,
  lineage: GmgnQuoteLineageEntry[] | null | undefined,
  createdLaunchpadStatus?: number | null,
): boolean {
  if (!supportsGmgnMutilWindowLineageChain(chainId) || !lineage?.length) return false;
  const token = normalizeAddress(tokenInfo.address);
  const first = lineage[0];
  if (!token || normalizeAddress(first?.token) !== token) return false;
  if (isTokenCurrentlyInner(chainId, tokenInfo)) return false;

  const createdStatus = Number(createdLaunchpadStatus);
  const freshStatus = Number(tokenInfo.launchpad_status);
  if (Number.isFinite(createdStatus) && Number.isFinite(freshStatus) && createdStatus !== freshStatus) {
    return false;
  }

  const knownHopPool = readKnownLineageHopPool(tokenInfo);
  const lineagePool = normalizeAddress(first.poolAddress);
  if (knownHopPool && lineagePool && knownHopPool !== lineagePool) return false;

  const declaredQuote = normalizeAddress(tokenInfo.quote_token_address);
  const lineageQuote = normalizeAddress(first.quote);
  if (
    declaredQuote
    && lineageQuote
    && !isTradeRouteTerminalQuote(chainId, declaredQuote)
    && declaredQuote !== lineageQuote
  ) {
    return false;
  }
  return true;
}

export function shouldRefreshGmgnQuoteLineage(
  chainId: number,
  tokenInfo: TokenInfo,
  lineage: GmgnQuoteLineageEntry[] | null | undefined,
  createdLaunchpadStatus?: number | null,
): boolean {
  if (!supportsGmgnMutilWindowLineageChain(chainId)) return false;
  if (isTokenCurrentlyInner(chainId, tokenInfo)) return false;
  if (isGmgnQuoteLineageUsable(chainId, tokenInfo, lineage, createdLaunchpadStatus)) return false;
  if (lineage?.length) return true;
  return needsGmgnQuoteLineageWalk(chainId, tokenInfo);
}

/** Prefetch list: traded token + its direct quote (from normalized tokenInfo). */
function planQuoteLineagePrefetchAddresses(
  chainId: number,
  tokenAddress: string,
  tokenInfo?: TokenInfo | null,
): string[] {
  const out = new Set<string>();
  const self = String(tokenAddress || '').trim().toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(self)) out.add(self);
  if (tokenInfo) {
    const directQuote = resolveEvmGmgnDirectQuoteToken(chainId, tokenInfo);
    if (directQuote && !isTradeRouteTerminalQuote(chainId, directQuote)) {
      out.add(directQuote.toLowerCase());
    }
  }
  return Array.from(out);
}

async function fetchGmgnTokenBatch(input: {
  chain: string;
  addresses: string[];
  pageFetch: (request: GmgnPageFetchRequest) => Promise<any>;
}): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const normalized = Array.from(new Set(
    input.addresses
      .map((a) => String(a || '').trim().toLowerCase())
      .filter((a) => /^0x[a-f0-9]{40}$/.test(a)),
  ));
  if (!normalized.length) return out;
  const [windowRequest, metaRequest] = await Promise.all([
    GmgnAPI.buildMultiWindowTokenInfoPageRequest(input.chain, normalized),
    GmgnAPI.buildMultiTokenInfoPageRequest(input.chain, normalized),
  ]);
  const [windowPayload, metaPayload] = await Promise.all([
    input.pageFetch(windowRequest).catch(() => null),
    input.pageFetch(metaRequest).catch(() => null),
  ]);
  const windowItems: Array<Record<string, unknown>> = Array.isArray(windowPayload?.data) ? windowPayload.data : [];
  const metaItems: Array<Record<string, unknown>> = Array.isArray(metaPayload?.data) ? metaPayload.data : [];
  const windowByAddress = new Map<string, Record<string, unknown>>();
  const metaByAddress = new Map<string, Record<string, unknown>>();
  for (const item of windowItems) {
    const addr = String(item?.address || '').trim().toLowerCase();
    if (addr) windowByAddress.set(addr, item);
  }
  for (const item of metaItems) {
    const addr = String(item?.address || '').trim().toLowerCase();
    if (addr) metaByAddress.set(addr, item);
  }
  for (const addr of normalized) {
    const merged = GmgnAPI.mergeGmgnApiTokenRows(windowByAddress.get(addr), metaByAddress.get(addr));
    if (merged) out.set(addr, merged);
  }
  return out;
}

/**
 * Walk token→quote→…→terminal via GMGN /mutil_window_token_info in the page
 * main world. Callers supply pageFetch (requestGmgnPageFetch); the service
 * worker must not call this with a direct fetch.
 *
 * Single-hop terminal pairs (e.g. GSTOCK→USDT) are valid lineage when that is
 * what mutil_window reports — no factory or launch_quote overrides.
 */
export async function walkGmgnQuoteLineage(input: {
  chainId: number;
  chain: string;
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
  pageFetch: (request: GmgnPageFetchRequest) => Promise<any>;
}): Promise<GmgnQuoteLineageEntry[] | null> {
  if (!supportsGmgnMutilWindowLineageChain(input.chainId)) return null;
  const chain = String(input.chain || '').trim();
  if (!chain) return null;
  const lineage: GmgnQuoteLineageEntry[] = [];
  const visited = new Set<string>();
  let current = String(input.tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(current)) return null;

  const itemMap = await fetchGmgnTokenBatch({
    chain,
    addresses: planQuoteLineagePrefetchAddresses(input.chainId, current, input.tokenInfo),
    pageFetch: input.pageFetch,
  }).catch(() => new Map<string, Record<string, unknown>>());

  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    if (isTradeRouteTerminalQuote(input.chainId, current)) break;

    let item = itemMap.get(current);
    if (!item) {
      const fetched = await fetchGmgnTokenBatch({
        chain,
        addresses: [current],
        pageFetch: input.pageFetch,
      }).catch(() => new Map<string, Record<string, unknown>>());
      item = fetched.get(current);
      fetched.forEach((value, key) => itemMap.set(key, value));
    }

    const row = item as MutilWindowTokenRow;
    const hop = resolveMutilWindowLineageHop(input.chainId, current, row);
    const quoteAddress = hop?.quote ?? null;
    const poolAddress = hop?.poolAddress ?? '';
    const preferHint = hop?.preferHint ?? null;
    if (!quoteAddress || quoteAddress === current || !poolAddress) break;

    lineage.push({
      token: current as `0x${string}`,
      quote: quoteAddress as `0x${string}`,
      poolAddress: poolAddress as `0x${string}`,
      preferHint,
      poolFactory: hop?.poolFactory ?? null,
      exchange: hop?.exchange ?? null,
    });
    if (isTradeRouteTerminalQuote(input.chainId, quoteAddress)) break;

    current = quoteAddress;
    const addressesToEnsure = new Set<string>([current]);
    const nextPrefetch = resolveMutilWindowLineagePrefetchQuote(
      input.chainId,
      current,
      itemMap.get(current) as MutilWindowTokenRow | undefined,
    );
    if (nextPrefetch) addressesToEnsure.add(nextPrefetch);
    const missing = Array.from(addressesToEnsure).filter((addr) => !itemMap.has(addr));
    if (missing.length) {
      const batch = await fetchGmgnTokenBatch({
        chain,
        addresses: missing,
        pageFetch: input.pageFetch,
      }).catch(() => new Map<string, Record<string, unknown>>());
      batch.forEach((value, key) => itemMap.set(key, value));
    }
  }

  if (!lineage.length) return null;
  const terminalQuote = lineage[lineage.length - 1]?.quote;
  if (!isTradeRouteTerminalQuote(input.chainId, terminalQuote)) return null;
  return lineage;
}
