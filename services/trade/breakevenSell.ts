/** Aligns with Tango paper breakeven: recover (remaining cost − cumulative realized PnL). */

export function computeBreakevenTargetUsd(
  currentBuyUsd: number | null | undefined,
  totalRealizedProfitUsd: number | null | undefined,
): number {
  const cost = Number(currentBuyUsd ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const realized = Number(totalRealizedProfitUsd ?? 0);
  const safeRealized = Number.isFinite(realized) ? realized : 0;
  const target = cost - safeRealized;
  return target <= 1e-6 ? 0 : target;
}

export function computeBreakevenSellPercent(input: {
  targetUsd: number;
  tokenBalanceAmount: number | null;
  tokenPriceUsd: number | null;
  slippageBps: number;
  networkFeeUsd?: number;
  platformFeeBps?: number;
}): number | null {
  const targetUsd = Number(input.targetUsd);
  const balance = Number(input.tokenBalanceAmount ?? 0);
  const priceUsd = Number(input.tokenPriceUsd ?? 0);
  if (!(targetUsd > 0) || !(balance > 0) || !(priceUsd > 0)) return null;
  const slippage = Math.max(0, Number(input.slippageBps || 0)) / 10_000;
  const feeRate = Math.max(0, Number(input.platformFeeBps ?? 0)) / 10_000;
  const executionPriceUsd = priceUsd * (1 - slippage);
  const grossFullUsd = balance * executionPriceUsd;
  if (!(grossFullUsd > 0)) return null;
  const networkFeeUsd = Math.max(0, Number(input.networkFeeUsd ?? 0));
  const targetGrossUsd = (targetUsd + networkFeeUsd) / Math.max(1e-9, 1 - feeRate);
  const percent = (targetGrossUsd / grossFullUsd) * 100;
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null;
}
