import { ChainId } from '@/constants/chains/chainId';
import { fetchGmgnQuoteLineageViaPage } from '@/services/gmgn/quoteLineageBridge';
import { getLimitOrders } from '@/services/storage';
import { TradeService } from '@/services/trade';
import { buildScopedTokenKey } from '@/services/xSniper/engine/metrics';
import type {
  GmgnQuoteLineageEntry,
  LimitOrder,
  LimitOrderSwapDesc,
  QuickTradeRoutePreview,
} from '@/types/extention';
import type { TokenInfo } from '@/types/token';

import { patchLimitOrder } from './store';

export type LimitOrderRouteTopology = {
  descs: LimitOrderSwapDesc[];
  preview: QuickTradeRoutePreview;
  launchpadStatus?: number;
};

/** One in-flight route build per token — coalesces batch creates and graduation refreshes. */
const routeBuildInflightByTokenKey = new Map<string, Promise<LimitOrderRouteTopology | null>>();

function tokenRouteKey(chainId: number, tokenAddress: string): string {
  return buildScopedTokenKey(chainId, tokenAddress);
}

export async function listOpenLimitOrdersForToken(chainId: number, tokenAddress: string): Promise<LimitOrder[]> {
  const scopedKey = tokenRouteKey(chainId, tokenAddress);
  const all = await getLimitOrders();
  return all.filter((o) => {
    if (o.status !== 'open') return false;
    return tokenRouteKey(o.chainId, o.tokenAddress) === scopedKey;
  });
}

/** Rebuild stored route when missing, or when inner → outer (one-time graduation). */
export function shouldRefreshLimitOrderRoute(
  previousTokenInfo: TokenInfo | null | undefined,
  tokenInfo: TokenInfo,
  orders: Array<Pick<LimitOrder, 'tradeRouteDescs' | 'tradeRouteLaunchpadStatus'>>,
): boolean {
  if (orders.some((o) => !o.tradeRouteDescs?.length)) return true;
  const prevStatus = Number(previousTokenInfo?.launchpad_status ?? Number.NaN);
  const nextStatus = Number(tokenInfo.launchpad_status ?? Number.NaN);
  if (Number.isFinite(prevStatus) && prevStatus !== 1 && nextStatus === 1) return true;
  const capturedStatus = orders.find((o) => Number.isFinite(Number(o.tradeRouteLaunchpadStatus)))?.tradeRouteLaunchpadStatus;
  if (
    Number.isFinite(capturedStatus)
    && Number.isFinite(nextStatus)
    && capturedStatus !== nextStatus
  ) {
    return true;
  }
  return false;
}

async function buildLimitOrderRouteTopology(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  baseTokenAddress?: string;
  gmgnQuoteLineageHint?: GmgnQuoteLineageEntry[];
}): Promise<LimitOrderRouteTopology | null> {
  if (input.chainId === ChainId.SOL) return null;
  const topology = await TradeService.resolveTradeRouteTopology({
    chainId: input.chainId,
    tokenAddress: input.tokenAddress as `0x${string}`,
    tokenInfo: input.tokenInfo,
    baseTokenAddress: input.baseTokenAddress as `0x${string}` | undefined,
    gmgnQuoteLineageHint: input.gmgnQuoteLineageHint,
    fetchGmgnLineage: () => fetchGmgnQuoteLineageViaPage({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenInfo: input.tokenInfo,
      timeoutMs: 8_000,
    }),
  });
  if (!topology?.descs.length || !topology.preview?.hops?.length) return null;
  const freshStatus = Number(input.tokenInfo.launchpad_status);
  return {
    descs: topology.descs as LimitOrderSwapDesc[],
    preview: topology.preview,
    launchpadStatus: Number.isFinite(freshStatus) ? freshStatus : undefined,
  };
}

/**
 * Build route topology once per token (deduped) and patch all open orders together.
 * Concurrent callers (batch create, graduation, scanner) share one GMGN/RPC round-trip.
 */
async function coalesceBuildAndPatchRouteForToken(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  baseTokenAddress?: string;
  gmgnQuoteLineageHint?: GmgnQuoteLineageEntry[];
}): Promise<LimitOrderRouteTopology | null> {
  const key = tokenRouteKey(input.chainId, input.tokenAddress);
  const inflight = routeBuildInflightByTokenKey.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const built = await buildLimitOrderRouteTopology(input);
    if (built) {
      const orders = await listOpenLimitOrdersForToken(input.chainId, input.tokenAddress);
      if (orders.length) await patchOrdersRouteTopology(orders, built);
    }
    return built;
  })().finally(() => {
    routeBuildInflightByTokenKey.delete(key);
  });
  routeBuildInflightByTokenKey.set(key, task);
  return task;
}

export async function patchOrdersRouteTopology(
  orders: LimitOrder[],
  patch: LimitOrderRouteTopology,
): Promise<void> {
  for (const order of orders) {
    await patchLimitOrder(order.id, {
      tradeRouteDescs: patch.descs,
      tradeRoutePreview: patch.preview,
      tradeRouteLaunchpadStatus: patch.launchpadStatus,
    });
    order.tradeRouteDescs = patch.descs;
    order.tradeRoutePreview = patch.preview;
    order.tradeRouteLaunchpadStatus = patch.launchpadStatus;
  }
}

/**
 * Refresh route for all open orders on a token when needed.
 * Returns true when topology was rebuilt and patched onto orders.
 */
export async function refreshLimitOrderRouteForToken(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  previousTokenInfo?: TokenInfo | null;
  baseTokenAddress?: string;
  gmgnQuoteLineageHint?: GmgnQuoteLineageEntry[];
}): Promise<boolean> {
  if (input.chainId === ChainId.SOL) return false;
  const openOrders = await listOpenLimitOrdersForToken(input.chainId, input.tokenAddress);
  if (!openOrders.length) return false;
  if (!shouldRefreshLimitOrderRoute(input.previousTokenInfo, input.tokenInfo, openOrders)) {
    return false;
  }

  const built = await coalesceBuildAndPatchRouteForToken(input);
  return !!built;
}
