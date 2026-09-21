import { browser } from 'wxt/browser';

import { ChainId } from '@/constants/chains/chainId';
import type { GmgnQuoteLineageEntry } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

const GMGN_TAB_URLS = ['*://gmgn.ai/*', '*://*.gmgn.ai/*'] as const;
const PAGE_BRIDGE_TIMEOUT_MS = 5_000;

/** Serialize GMGN walks — background may prewarm many limit-order tokens at once. */
let walkQueueTail: Promise<unknown> = Promise.resolve();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gmgn_quote_lineage_timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function chainNameForLineage(chainId: number): string | null {
  if (chainId === ChainId.BNB) return 'bsc';
  return null;
}

/**
 * Re-walk a token's GMGN quote lineage via an open gmgn.ai tab.
 * Background cannot fetch GMGN (CORS + cookies). Used when a stored
 * limit-order lineage is stale after inner→outer graduation or a pool change.
 * Returns null quickly when no gmgn tab is open.
 */
async function fetchGmgnQuoteLineageViaPageImmediate(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
  timeoutMs?: number;
}): Promise<GmgnQuoteLineageEntry[] | null> {
  const chain = chainNameForLineage(input.chainId);
  const token = String(input.tokenAddress || '').trim();
  if (!chain || !token) return null;

  const timeoutMs = Math.max(800, Math.min(input.timeoutMs ?? PAGE_BRIDGE_TIMEOUT_MS, 8_000));
  try {
    const tabs = await browser.tabs.query({ url: [...GMGN_TAB_URLS] });
    if (!tabs.length) return null;

    const settled = await Promise.all(
      tabs
        .filter((tab) => !!tab.id)
        .map(async (tab) => {
          try {
            const rsp = await withTimeout(
              browser.tabs.sendMessage(tab.id as number, {
                type: 'bg:gmgn:pageQuoteLineage',
                chain,
                chainId: input.chainId,
                tokenAddress: token,
                tokenInfo: input.tokenInfo ?? undefined,
              }),
              timeoutMs,
            );
            if (rsp?.ok && Array.isArray(rsp?.lineage) && rsp.lineage.length > 0) {
              return rsp.lineage as GmgnQuoteLineageEntry[];
            }
          } catch {
          }
          return null;
        }),
    );

    return settled.find((lineage) => Array.isArray(lineage) && lineage.length > 0) ?? null;
  } catch {
    return null;
  }
}

export async function fetchGmgnQuoteLineageViaPage(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
  timeoutMs?: number;
}): Promise<GmgnQuoteLineageEntry[] | null> {
  const run = () => fetchGmgnQuoteLineageViaPageImmediate(input);
  const task = walkQueueTail.then(run, run);
  walkQueueTail = task.catch(() => { });
  return task;
}
