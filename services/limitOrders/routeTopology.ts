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

/** Catch limit orders created while an in-flight route build was patching. */
const deferredRoutePatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

/**
 * Whether open orders on ONE token need a route rebuild.
 * Always scoped to (chainId, tokenAddress) — never the content-script page token.
 * Compares fresh tokenInfo for that address vs the route snapshot stored on its orders.
 */
export function shouldRefreshLimitOrderRoute(
  previousTokenInfo: TokenInfo | null | undefined,
  tokenInfo: TokenInfo,
  orders: Array<Pick<LimitOrder, 'tradeRouteDescs' | 'tradeRouteLaunchpadStatus'>>,
): boolean {
  if (orders.some((o) => !o.tradeRouteDescs?.length)) return true;
  const prevStatus = Number(previousTokenInfo?.launchpad_status ?? Number.NaN);
  const nextStatus = Number(tokenInfo.launchpad_status ?? Number.NaN);
  // Inner → outer graduation for this token only (e.g. Flap/Fourmeme 0 → 1).
  if (Number.isFinite(prevStatus) && prevStatus !== 1 && nextStatus === 1) return true;
  // Route was built at capturedStatus; token moved since then on the same address.
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

function routePrepareBudgetMs(chainId: number): number {
  // RH (V4 / Pons / GMGN lineage) routinely exceeds BSC prepare time.
  return chainId === ChainId.RH ? 25_000 : 15_000;
}

function scheduleDeferredRoutePatch(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  baseTokenAddress?: string;
  gmgnQuoteLineageHint?: GmgnQuoteLineageEntry[];
}) {
  const key = tokenRouteKey(input.chainId, input.tokenAddress);
  const existing = deferredRoutePatchTimers.get(key);
  if (existing) clearTimeout(existing);
  deferredRoutePatchTimers.set(key, setTimeout(() => {
    deferredRoutePatchTimers.delete(key);
    void (async () => {
      const orders = await listOpenLimitOrdersForToken(input.chainId, input.tokenAddress);
      if (!orders.length) return;
      const previous = orders.find((o) => o.tokenInfo)?.tokenInfo ?? null;
      if (!shouldRefreshLimitOrderRoute(previous, input.tokenInfo, orders)) return;
      await coalesceBuildAndPatchRouteForToken(input);
    })().catch(() => { });
  }, 2000));
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
    prepareBudgetMs: routePrepareBudgetMs(input.chainId),
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
      // Re-list at patch time — batch auto-sell may land the 2nd order during build.
      const orders = await listOpenLimitOrdersForToken(input.chainId, input.tokenAddress);
      if (orders.length) await patchOrdersRouteTopology(orders, built);
      scheduleDeferredRoutePatch(input);
    }
    return built;
  })().finally(() => {
    routeBuildInflightByTokenKey.delete(key);
  });
  routeBuildInflightByTokenKey.set(key, task);
  return task;
}

/** Ensure every open order on the token has a current route (create batch + inner→outer). */
export async function ensureLimitOrderRoutesReady(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  previousTokenInfo?: TokenInfo | null;
  baseTokenAddress?: string;
  gmgnQuoteLineageHint?: GmgnQuoteLineageEntry[];
}): Promise<LimitOrderRouteTopology | null> {
  if (input.chainId === ChainId.SOL) return null;
  const openOrders = await listOpenLimitOrdersForToken(input.chainId, input.tokenAddress);
  if (!openOrders.length) return null;
  const previous = input.previousTokenInfo ?? openOrders.find((o) => o.tokenInfo)?.tokenInfo ?? null;
  if (!shouldRefreshLimitOrderRoute(previous, input.tokenInfo, openOrders)) {
    const sample = openOrders.find((o) => o.tradeRouteDescs?.length);
    if (!sample?.tradeRouteDescs?.length || !sample.tradeRoutePreview?.hops?.length) return null;
    return {
      descs: sample.tradeRouteDescs,
      preview: sample.tradeRoutePreview,
      launchpadStatus: sample.tradeRouteLaunchpadStatus,
    };
  }
  return coalesceBuildAndPatchRouteForToken(input);
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
  const previous = input.previousTokenInfo ?? openOrders.find((o) => o.tokenInfo)?.tokenInfo ?? null;
  if (!shouldRefreshLimitOrderRoute(previous, input.tokenInfo, openOrders)) {
    return false;
  }

  const built = await coalesceBuildAndPatchRouteForToken(input);
  return !!built;
}
