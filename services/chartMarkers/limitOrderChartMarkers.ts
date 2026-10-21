import type { LimitOrder } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { normalizeGmgnChartChain, normalizeGmgnTokenSlug } from '@/services/chartMarkers/chartFrameUtils';
import { normalizeAddressKey } from '@/services/xSniper/engine/metrics';

/** GMGN chart + iframe symbol slugs (avoid `@/constants/chains` barrel → viem in content bundle). */
const toGmgnChartChainSlug = (chainName: string) => {
  const key = normalizeGmgnChartChain(chainName);
  if (key === 'rh') return 'robinhood';
  if (key === 'bnb') return 'bsc';
  return key;
};

export type LimitOrderChartMarker = {
  id: string;
  side: 'BUY' | 'SELL';
  marketCap: number;
  price: number;
  label: string;
  closeLabel: string;
};

export type LimitOrderChartMarkerPayload = {
  chain: string;
  tokenAddress: string;
  currentPrice?: number;
  currentMarketCap?: number;
  markers: LimitOrderChartMarker[];
};

/** Same supply logic as LimitTradePanel.getEffectiveTokenSupply (prefers live page tokenInfo). */
const resolveSupply = (
  order: LimitOrder,
  currentPriceUsd?: number | null,
  liveTokenInfo?: TokenInfo | null,
): number => {
  const tokenInfo = liveTokenInfo ?? order.tokenInfo;
  const spotPrice = Number(
    (currentPriceUsd != null && currentPriceUsd > 0 ? currentPriceUsd : undefined)
      ?? tokenInfo?.tokenPrice?.price
      ?? 0,
  );
  const marketCapText = String(tokenInfo?.tokenPrice?.marketCap ?? '').trim();
  const marketCap = Number(marketCapText);
  if (Number.isFinite(marketCap) && marketCap > 0 && Number.isFinite(spotPrice) && spotPrice > 0) {
    return marketCap / spotPrice;
  }
  const supply = Number(String(tokenInfo?.totalSupply ?? '').trim());
  if (Number.isFinite(supply) && supply > 0) return supply;
  return 1_000_000_000;
};

export const buildLimitOrderChartMarkerPayload = (input: {
  chainName: string;
  tokenAddress: string;
  orders: LimitOrder[];
  currentPriceUsd?: number | null;
  liveTokenInfo?: TokenInfo | null;
  labels?: { buy: string; sell: string; hide: string };
}): LimitOrderChartMarkerPayload | null => {
  const chain = toGmgnChartChainSlug(input.chainName);
  const tokenAddress = normalizeGmgnTokenSlug(String(input.tokenAddress || '').trim());
  if (!chain || !tokenAddress) return null;
  const tokenKey = normalizeAddressKey(tokenAddress);
  const openOrders = input.orders.filter((order) => (
    order.status === 'open' && normalizeAddressKey(order.tokenAddress) === tokenKey
  ));
  const labels = input.labels ?? { buy: '挂单买', sell: '挂单卖', hide: '隐藏' };
  const supply = openOrders.length
    ? resolveSupply(openOrders[0], input.currentPriceUsd, input.liveTokenInfo)
    : 0;
  const currentPrice = Number(input.currentPriceUsd ?? 0);
  const currentMarketCap = currentPrice > 0 && supply > 0 ? currentPrice * supply : 0;
  const markers = openOrders.map((order) => {
    const price = Number(order.triggerPriceUsd);
    const marketCap = price > 0 && supply > 0 ? price * supply : 0;
    return {
      id: `limit:${order.id}`,
      side: order.side === 'buy' ? 'BUY' as const : 'SELL' as const,
      marketCap,
      price,
      label: order.side === 'buy' ? labels.buy : labels.sell,
      closeLabel: labels.hide,
    };
  }).filter((marker) => marker.marketCap > 0 || marker.price > 0);
  return {
    chain,
    tokenAddress,
    currentPrice: currentPrice > 0 ? currentPrice : undefined,
    currentMarketCap: currentMarketCap > 0 ? currentMarketCap : undefined,
    markers,
  };
};
