/**
 * GMGN mutil_window quote-lineage policy — shared by BSC and RH.
 * Launchpad platform only affects how the *last hop* is encoded (inner curve,
 * outer Infinity/V4, V2/V3).
 *
 * Quote / prefix pipeline (shared):
 *  1. Inner launchpad (launchpad_status ≠ 1) → last hop is launchpad curve; still
 *     walk GMGN quote→terminal when direct quote is non-terminal (e.g. GMEB→USDT).
 *  2. Resolve direct quote from normalized tokenInfo.quote_token_address
 *     (mutil_window pool/tpool quote — terminal stables included).
 *  3. Outer + non-terminal direct quote (or missing quote) → GMGN lineage walk.
 *  4. Prefix payToken → quote via buildOuterMarketBuyQuoteRoute (gmgn lineage first).
 *  5. Last hop: pool shape (V2/V3/Infinity or RH V4 bytes32) or platform swap desc.
 */
import { ChainId } from '@/constants/chains/chainId';
import type { TokenInfo } from '@/types/token';
import { isTradeRouteTerminalQuote } from '@/utils/tradeRouteTerminals';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const GMGN_MUTIL_WINDOW_LINEAGE_CHAINS = new Set<number>([ChainId.BNB, ChainId.RH]);

export function supportsGmgnMutilWindowLineageChain(chainId: number): boolean {
  return GMGN_MUTIL_WINDOW_LINEAGE_CHAINS.has(chainId);
}

function normalizeAddress(value?: string | null): `0x${string}` | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(raw) || raw === ZERO_ADDRESS) return null;
  return raw as `0x${string}`;
}

export function isEvmInnerLaunchpadToken(chainId: number, tokenInfo: TokenInfo): boolean {
  if (!supportsGmgnMutilWindowLineageChain(chainId)) return false;
  const hasLaunchpad = !!String(tokenInfo.launchpad || tokenInfo.launchpad_platform || '').trim();
  if (!hasLaunchpad) return false;
  return Number(tokenInfo.launchpad_status ?? 0) !== 1;
}

/** @deprecated Use isEvmInnerLaunchpadToken */
export function isBscInnerLaunchpadToken(chainId: number, tokenInfo: TokenInfo): boolean {
  return isEvmInnerLaunchpadToken(chainId, tokenInfo);
}

/**
 * Direct quote counterparty for route planning — platform-agnostic.
 * Uses normalized tokenInfo only (no launchpad-name branches).
 */
export function resolveEvmGmgnDirectQuoteToken(chainId: number, tokenInfo: TokenInfo): `0x${string}` | null {
  if (!supportsGmgnMutilWindowLineageChain(chainId)) return null;
  const self = normalizeAddress(tokenInfo.address);
  const raw = normalizeAddress(tokenInfo.quote_token_address);
  if (raw && self && raw !== self) return raw;
  return raw;
}

/** @deprecated Use resolveEvmGmgnDirectQuoteToken */
export function resolveBscDirectQuoteToken(chainId: number, tokenInfo: TokenInfo): `0x${string}` | null {
  return resolveEvmGmgnDirectQuoteToken(chainId, tokenInfo);
}

/** mutil_window reports a direct terminal pair — use DEX route, not factory curve. */
export function usesMutilWindowDirectTerminalMarket(chainId: number, tokenInfo: TokenInfo): boolean {
  const quote = resolveEvmGmgnDirectQuoteToken(chainId, tokenInfo);
  return !!quote && isTradeRouteTerminalQuote(chainId, quote);
}

/** @deprecated Use usesMutilWindowDirectTerminalMarket */
export function usesBscMutilWindowDirectTerminalMarket(chainId: number, tokenInfo: TokenInfo): boolean {
  return usesMutilWindowDirectTerminalMarket(chainId, tokenInfo);
}

/** Whether the page should walk GMGN quote lineage before prewarm (BSC/RH). */
export function needsGmgnQuoteLineageWalk(chainId: number, tokenInfo?: TokenInfo | null): boolean {
  if (!supportsGmgnMutilWindowLineageChain(chainId) || !tokenInfo) return false;
  const quote = resolveEvmGmgnDirectQuoteToken(chainId, tokenInfo);
  if (!quote) return !isEvmInnerLaunchpadToken(chainId, tokenInfo);
  return !isTradeRouteTerminalQuote(chainId, quote);
}

/** @deprecated Use needsGmgnQuoteLineageWalk */
export function needsBscGmgnQuoteLineageWalk(chainId: number, tokenInfo?: TokenInfo | null): boolean {
  return needsGmgnQuoteLineageWalk(chainId, tokenInfo);
}
