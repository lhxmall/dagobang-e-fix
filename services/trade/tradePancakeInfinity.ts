import { getAddress, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { RpcService } from '@/services/rpc';
import { isNonPancakeInfinityV4DexText, isPancakeInfinityDexText } from '@/utils/dexUtils';

import {
  Address,
  Hex,
  SwapType,
  ZERO_ADDRESS,
  ZERO32,
  getRouterSwapDesc,
  getWNative,
  type SwapDescLike,
} from './tradeTypes';

export type PancakeInfinityPoolKey = {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
};

const clPoolManagerAbi = parseAbi([
  'function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)',
]);

const poolKeyCache = new Map<string, { ts: number; value: PancakeInfinityPoolKey | null }>();
const poolKeyInFlight = new Map<string, Promise<PancakeInfinityPoolKey | null>>();
const POOL_KEY_TTL_MS = 60_000;
/** Failed reads must not block Infinity for long — DexScreener USDT V3 would win otherwise. */
const POOL_KEY_NULL_TTL_MS = 3_000;

function asAddress(value: unknown): Address {
  const raw = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/i.test(raw)) return ZERO_ADDRESS;
  try {
    return getAddress(raw as Address);
  } catch {
    return ZERO_ADDRESS;
  }
}

function asHex32(value: unknown): Hex {
  const raw = String(value || '').trim().toLowerCase();
  if (/^0x[a-f0-9]{64}$/.test(raw)) return raw as Hex;
  return ZERO32;
}

function isZero(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

/** GMGN / Infinity pool ids are bytes32, not pair contract addresses. */
export function isPancakeInfinityPoolId(value?: string | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

export function getConfiguredPancakeInfinityClPoolManager(): Address {
  const configured = DeployAddress[ChainId.BNB]?.[ContractNames.PancakeInfinityClPoolManager]?.address;
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) {
    return getAddress(configured as Address);
  }
  return '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b' as Address;
}

export function extractPancakeInfinityPoolId(tokenInfo?: {
  pool_pair?: string | null;
  biggest_pool_address?: string | null;
  tpool_pool_address?: string | null;
  dex_type?: string | null;
} | null): `0x${string}` | null {
  const dex = String(tokenInfo?.dex_type || '').trim();
  if (isNonPancakeInfinityV4DexText(dex)) return null;
  for (const candidate of [
    tokenInfo?.biggest_pool_address,
    tokenInfo?.pool_pair,
    tokenInfo?.tpool_pool_address,
  ]) {
    if (!isPancakeInfinityPoolId(candidate)) continue;
    // Trust bytes32 pool refs from mutil_window; poolIdToPoolKey validates at route time.
    // Block only when dex_type explicitly tags a non-Pancake V4 launchpad (openfour, etc.).
    if (dex && isNonPancakeInfinityV4DexText(dex) && !isPancakeInfinityDexText(dex)) continue;
    return String(candidate).trim().toLowerCase() as `0x${string}`;
  }
  return null;
}

/** Sync peek — undefined = never probed; null = probed and not Infinity. */
export function peekCachedPancakeInfinityPoolKey(poolId: string): PancakeInfinityPoolKey | null | undefined {
  const id = String(poolId || '').trim().toLowerCase();
  if (!isPancakeInfinityPoolId(id)) return undefined;
  const cached = poolKeyCache.get(id);
  if (!cached) return undefined;
  const ttl = cached.value ? POOL_KEY_TTL_MS : POOL_KEY_NULL_TTL_MS;
  if (Date.now() - cached.ts >= ttl) return undefined;
  return cached.value;
}

export async function readPancakeInfinityPoolKey(poolId: string): Promise<PancakeInfinityPoolKey | null> {
  const id = String(poolId || '').trim().toLowerCase();
  if (!isPancakeInfinityPoolId(id)) return null;
  const cached = poolKeyCache.get(id);
  if (cached) {
    const ttl = cached.value ? POOL_KEY_TTL_MS : POOL_KEY_NULL_TTL_MS;
    if (Date.now() - cached.ts < ttl) return cached.value;
  }
  const inflight = poolKeyInFlight.get(id);
  if (inflight) return await inflight;

  const task = (async () => {
    try {
      const clPm = getConfiguredPancakeInfinityClPoolManager();
      const raw = await RpcService.withBalancedReadClient({
        chainId: ChainId.BNB,
        caller: 'infinity.poolIdToPoolKey',
        run: async (client) => await client.readContract({
          address: clPm,
          abi: clPoolManagerAbi,
          functionName: 'poolIdToPoolKey',
          args: [id as `0x${string}`],
        }),
      });
      const row = Array.isArray(raw) ? raw : (raw ?? {});
      const currency0 = asAddress(Array.isArray(row) ? row[0] : row.currency0);
      const currency1 = asAddress(Array.isArray(row) ? row[1] : row.currency1);
      const hooks = asAddress(Array.isArray(row) ? row[2] : row.hooks);
      const poolManager = asAddress(Array.isArray(row) ? row[3] : row.poolManager);
      const fee = Number(Array.isArray(row) ? row[4] : row.fee) || 0;
      const parameters = asHex32(Array.isArray(row) ? row[5] : row.parameters);
      if (isZero(currency0) && isZero(currency1)) return null;
      if (isZero(poolManager)) return null;
      const value: PancakeInfinityPoolKey = {
        currency0,
        currency1,
        hooks,
        poolManager,
        fee,
        parameters,
      };
      poolKeyCache.set(id, { ts: Date.now(), value });
      return value;
    } catch {
      poolKeyCache.set(id, { ts: Date.now(), value: null });
      return null;
    } finally {
      poolKeyInFlight.delete(id);
    }
  })();

  poolKeyInFlight.set(id, task);
  return await task;
}

/** Router uses address(0) for native BNB; Infinity PoolKey may use address(0) or WBNB. */
export function infinityCurrencyToRouterToken(currency: Address): Address {
  if (isZero(currency)) return ZERO_ADDRESS;
  const wNative = getWNative(ChainId.BNB);
  if (currency.toLowerCase() === wNative.toLowerCase()) return ZERO_ADDRESS;
  return currency;
}

export function infinityPoolQuoteRouterToken(
  poolKey: PancakeInfinityPoolKey,
  tokenAddress: Address,
): Address | null {
  const token = tokenAddress.toLowerCase();
  const c0 = infinityCurrencyToRouterToken(poolKey.currency0);
  const c1 = infinityCurrencyToRouterToken(poolKey.currency1);
  if (c0.toLowerCase() === token) return c1;
  if (c1.toLowerCase() === token) return c0;
  // PoolKey may store WBNB while token side compares as native-normalized.
  const wNative = getWNative(ChainId.BNB).toLowerCase();
  if (poolKey.currency0.toLowerCase() === token || (token === ZERO_ADDRESS.toLowerCase() && poolKey.currency0.toLowerCase() === wNative)) {
    return c1;
  }
  if (poolKey.currency1.toLowerCase() === token || (token === ZERO_ADDRESS.toLowerCase() && poolKey.currency1.toLowerCase() === wNative)) {
    return c0;
  }
  return null;
}

export function tickSpacingFromInfinityParameters(parameters: Hex): number {
  try {
    const raw = (BigInt(parameters) >> 16n) & 0xffffffn;
    let tick = Number(raw);
    if (tick >= 0x800000) tick -= 0x1000000;
    return tick;
  } catch {
    return 0;
  }
}

export function buildPancakeInfinityExactInDesc(input: {
  tokenIn: Address;
  tokenOut: Address;
  poolKey: PancakeInfinityPoolKey;
}): SwapDescLike {
  return getRouterSwapDesc({
    swapType: SwapType.PANCAKE_INFINITY_EXACT_IN,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    poolAddress: ZERO_ADDRESS,
    fee: input.poolKey.fee,
    tickSpacing: tickSpacingFromInfinityParameters(input.poolKey.parameters),
    hooks: input.poolKey.hooks,
    poolManager: input.poolKey.poolManager,
    parameters: input.poolKey.parameters,
  });
}

const PANCAKE_INFINITY_CL_QUOTER = '0xd0737C9762912dD34c3271197E362Aa736Df0926' as Address;
const clQuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/** Quote Pancake Infinity CL exact-in via the public CL Quoter. */
export async function quotePancakeInfinityExactIn(input: {
  poolKey: PancakeInfinityPoolKey;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}): Promise<bigint> {
  if (input.amountIn <= 0n) return 0n;
  const zeroForOne = input.tokenIn.toLowerCase() < input.tokenOut.toLowerCase();
  try {
    const raw = await RpcService.withBalancedReadClient({
      chainId: ChainId.BNB,
      caller: 'infinity.quoteExactInputSingle',
      run: async (client) => await client.simulateContract({
        address: PANCAKE_INFINITY_CL_QUOTER,
        abi: clQuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{
          poolKey: {
            currency0: input.poolKey.currency0,
            currency1: input.poolKey.currency1,
            hooks: input.poolKey.hooks,
            poolManager: input.poolKey.poolManager,
            fee: input.poolKey.fee,
            parameters: input.poolKey.parameters,
          },
          zeroForOne,
          exactAmount: input.amountIn,
          hookData: '0x',
        }],
      }),
    });
    const amountOut = Array.isArray(raw.result) ? raw.result[0] : raw.result;
    return BigInt(amountOut ?? 0n);
  } catch {
    return 0n;
  }
}

export async function resolveBnbInfinityRouteFromTokenInfo(input: {
  tokenAddress: Address;
  tokenInfo?: {
    pool_pair?: string | null;
    biggest_pool_address?: string | null;
    tpool_pool_address?: string | null;
  } | null;
}): Promise<{
  poolId: `0x${string}`;
  poolKey: PancakeInfinityPoolKey;
  quoteRouterToken: Address;
} | null> {
  const poolId = extractPancakeInfinityPoolId(input.tokenInfo);
  if (!poolId) return null;
  const poolKey = await readPancakeInfinityPoolKey(poolId);
  if (!poolKey) return null;
  const quoteRouterToken = infinityPoolQuoteRouterToken(poolKey, input.tokenAddress);
  if (quoteRouterToken == null) return null;
  return { poolId, poolKey, quoteRouterToken };
}
