import type { LimitOrder } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import {
  buildLimitOrderChartMarkerPayload,
  type LimitOrderChartMarkerPayload,
} from '@/services/chartMarkers/limitOrderChartMarkers';

/** GMGN top frame: LimitTradePanel / App → chart bridge (same tab, no background round-trip). */
export const DAGOBANG_CHART_MARKERS_EVENT = 'dagobang-chart-markers';

export type PublishGmgnLimitOrderChartMarkersInput = {
  chainName: string;
  tokenAddress: string;
  orders: LimitOrder[];
  currentPriceUsd?: number | null;
  liveTokenInfo?: TokenInfo | null;
  labels?: { buy: string; sell: string; hide: string };
};

export const resolveLiveSpotPriceUsd = (input: {
  currentPriceUsd?: number | null;
  tokenInfo?: TokenInfo | null;
}): number | null => {
  if (input.currentPriceUsd != null && Number.isFinite(input.currentPriceUsd) && input.currentPriceUsd > 0) {
    return input.currentPriceUsd;
  }
  const fromTokenPrice = Number(input.tokenInfo?.tokenPrice?.price ?? 0);
  if (Number.isFinite(fromTokenPrice) && fromTokenPrice > 0) return fromTokenPrice;
  const legacy = Number((input.tokenInfo as { price?: string | number } | undefined)?.price ?? 0);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  return null;
};

export const publishGmgnLimitOrderChartMarkers = (input: PublishGmgnLimitOrderChartMarkersInput): void => {
  if (typeof window === 'undefined') return;
  const payload = buildLimitOrderChartMarkerPayload({
    chainName: input.chainName,
    tokenAddress: input.tokenAddress,
    orders: input.orders,
    currentPriceUsd: resolveLiveSpotPriceUsd({
      currentPriceUsd: input.currentPriceUsd,
      tokenInfo: input.liveTokenInfo,
    }),
    liveTokenInfo: input.liveTokenInfo,
    labels: input.labels,
  });
  const detail: LimitOrderChartMarkerPayload = payload ?? {
    chain: '',
    tokenAddress: '',
    markers: [],
  };
  window.dispatchEvent(new CustomEvent(DAGOBANG_CHART_MARKERS_EVENT, { detail }));
};
