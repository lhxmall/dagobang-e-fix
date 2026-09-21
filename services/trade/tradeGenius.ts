import { encodeAbiParameters, getAddress, parseAbi, parseAbiParameters } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { RpcService } from '@/services/rpc';

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

const BPS_DENOM = 10_000n;
const GENIUS_TRADE_STATE_INNER_TTL_MS = 5000;
const GENIUS_TRADE_STATE_OUTER_TTL_MS = 30_000;

/** Genius.fun production factory (Pons v2-compatible ABI), BNB mainnet. */
export const GENIUS_LAUNCH_FACTORY = '0x37eE8AeE29C5efd3C1A7edA6dF3F510779928a37' as Address;
/**
 * Genius.fun legacy factory (pre-4.2.0 stack). Tokens launched before the
 * 2026-09-19 prod-foundation-4.2.0 release live here; the active factory above
 * returns empty `getLaunchedToken` for them. Probe both and keep whichever
 * returns a real launch record.
 */
export const GENIUS_LEGACY_LAUNCH_FACTORY = '0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31' as Address;
export const GENIUS_MEME_HOOK = '0x8E6f8eBbD62B60085B703C40B460daE802eDC51b' as Address;
export const GENIUS_LEGACY_MEME_HOOK = '0xFf17F41c5Efd6CCe944Af0912F300097D62df5c9' as Address;
export const GENIUS_CL_QUOTER = '0xd0737C9762912dD34c3271197E362Aa736Df0926' as Address;

const geniusFactoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function poolKeyFor(address token) view returns ((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
]);

const geniusCurveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
]);

const clQuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
]);

const abiParamsUint256 = parseAbiParameters('uint256');

export const GENIUS_PHASE = {
  NotGraduated: 0,
  Swept: 1,
  PoolCreated: 2,
  Rescued: 3,
} as const;

export type GeniusPoolKey = {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
};

export type GeniusTradeState = {
  phase: number;
  isInner: boolean;
  isOuter: boolean;
  tradeable: boolean;
  curve: Address;
  pairToken: Address;
  quoteRouterToken: Address;
  isNativeQuote: boolean;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  graduationThreshold: bigint;
  memeHook: Address;
  poolKey: GeniusPoolKey | null;
};

export type GeniusBuyQuote = {
  tokensOut: bigint;
  spent: bigint;
  fee: bigint;
  tax: bigint;
  snipe: bigint;
  refund: bigint;
};

type GeniusTradeStateOptions = {
  force?: boolean;
};

const geniusTradeStateCache = new Map<string, { ts: number; value: GeniusTradeState | null }>();
const geniusTradeStateInFlight = new Map<string, Promise<GeniusTradeState | null>>();

async function withBnbRead<T>(caller: string, run: (client: any) => Promise<T>): Promise<T> {
  return await RpcService.withBalancedReadClient({
    chainId: ChainId.BNB,
    caller,
    run,
  });
}

function expectAddress(value: string | undefined, label: string): Address {
  const trimmed = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`${label} address not set`);
  }
  return getAddress(trimmed as Address);
}

function asAddress(value: unknown): Address {
  const raw = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/i.test(raw)) return ZERO_ADDRESS;
  try {
    return getAddress(raw as Address);
  } catch {
    return ZERO_ADDRESS;
  }
}

function isZero(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

function asHex32(value: unknown): Hex {
  const raw = String(value || '').trim().toLowerCase();
  if (/^0x[a-f0-9]{64}$/.test(raw)) return raw as Hex;
  return ZERO32;
}

export function isGeniusPlatform(platform: string | null | undefined): boolean {
  const value = String(platform || '').trim().toLowerCase();
  return value === 'geniusfun' || value === 'genius' || value === 'genius.fun' || value === 'genius_fun';
}

export function getConfiguredGeniusFactory(): Address {
  const configured = DeployAddress[ChainId.BNB]?.[ContractNames.GeniusLaunchFactory]?.address;
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) {
    return getAddress(configured as Address);
  }
  return GENIUS_LAUNCH_FACTORY;
}

export function getConfiguredGeniusMemeHook(): Address {
  const configured = DeployAddress[ChainId.BNB]?.[ContractNames.GeniusMemeHook]?.address;
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) {
    return getAddress(configured as Address);
  }
  return GENIUS_MEME_HOOK;
}

export function getConfiguredGeniusClPoolManager(): Address {
  return expectAddress(
    DeployAddress[ChainId.BNB]?.[ContractNames.PancakeInfinityClPoolManager]?.address,
    'Pancake Infinity CL pool manager',
  );
}

export function getConfiguredDagobangRouter(): Address {
  return expectAddress(
    DeployAddress[ChainId.BNB]?.[ContractNames.DagobangRouter]?.address,
    'DagobangRouter',
  );
}

export function encodeGeniusMinOut(minOut: bigint): Hex {
  return encodeAbiParameters(abiParamsUint256, [minOut]) as Hex;
}

function toQuoteRouterToken(pairToken: Address, isNativeQuote: boolean): Address {
  if (isNativeQuote || isZero(pairToken)) return ZERO_ADDRESS;
  const wNative = getWNative(ChainId.BNB);
  if (pairToken.toLowerCase() === wNative.toLowerCase()) return ZERO_ADDRESS;
  return pairToken;
}

function parseLaunch(raw: any): {
  token: Address;
  curve: Address;
  pairToken: Address;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  graduationThreshold: bigint;
  phase: number;
  exists: boolean;
} | null {
  const row = Array.isArray(raw) ? raw : (raw ?? {});
  const exists = Boolean(Array.isArray(row) ? row[14] : row.exists);
  const curve = asAddress(Array.isArray(row) ? row[1] : row.curve);
  if (!exists && isZero(curve)) return null;
  return {
    token: asAddress(Array.isArray(row) ? row[0] : row.token),
    curve,
    pairToken: asAddress(Array.isArray(row) ? row[4] : row.pairToken),
    poolFee: Number(Array.isArray(row) ? row[6] : row.poolFee) || 0,
    tickSpacing: Number(Array.isArray(row) ? row[7] : row.tickSpacing) || 0,
    creatorTaxBps: Number(Array.isArray(row) ? row[8] : row.creatorTaxBps) || 0,
    graduationThreshold: BigInt(Array.isArray(row) ? (row[5] ?? 0) : (row.graduationThreshold ?? 0)),
    phase: Number(Array.isArray(row) ? row[10] : row.phase) || 0,
    exists,
  };
}

function parsePoolKey(raw: any): GeniusPoolKey | null {
  const row = Array.isArray(raw) ? raw : (raw ?? {});
  const currency0 = asAddress(Array.isArray(row) ? row[0] : row.currency0);
  const currency1 = asAddress(Array.isArray(row) ? row[1] : row.currency1);
  const hooks = asAddress(Array.isArray(row) ? row[2] : row.hooks);
  const poolManager = asAddress(Array.isArray(row) ? row[3] : row.poolManager);
  const fee = Number(Array.isArray(row) ? row[4] : row.fee) || 0;
  const parameters = asHex32(Array.isArray(row) ? row[5] : row.parameters);
  if (isZero(currency0) && isZero(currency1)) return null;
  if (isZero(poolManager)) return null;
  return { currency0, currency1, hooks, poolManager, fee, parameters };
}

async function loadGeniusTradeState(tokenAddress: Address): Promise<GeniusTradeState | null> {
  return await withBnbRead('genius.tradeState', async (client) => {
    // Tokens launched before the 2026-09-19 4.2.0 release live on the legacy
    // factory; the active factory returns empty for them. Probe both and use
    // whichever returns a real launch record. Try active first (new tokens),
    // then legacy (older tokens like GSTOCK).
    const factoryCandidates = [getConfiguredGeniusFactory(), GENIUS_LEGACY_LAUNCH_FACTORY];
    let factory: Address = factoryCandidates[0];
    let raw: unknown = null;
    let launch: ReturnType<typeof parseLaunch> = null;
    for (const candidate of factoryCandidates) {
      try {
        const tried = await client.readContract({
          address: candidate,
          abi: geniusFactoryAbi,
          functionName: 'getLaunchedToken',
          args: [tokenAddress],
        });
        const parsed = parseLaunch(tried);
        if (parsed?.exists && !isZero(parsed.curve)) {
          factory = candidate;
          raw = tried;
          launch = parsed;
          break;
        }
      } catch {
        // try next factory
      }
    }
    if (!launch?.exists || isZero(launch.curve)) return null;

    let isNativeQuote = isZero(launch.pairToken);
    try {
      isNativeQuote = Boolean(await client.readContract({
        address: launch.curve,
        abi: geniusCurveAbi,
        functionName: 'isNativeQuote',
      }));
    } catch {
    }

    const phase = launch.phase;
    const isInner = phase === GENIUS_PHASE.NotGraduated;
    const isOuter = phase === GENIUS_PHASE.PoolCreated;
    let poolKey: GeniusPoolKey | null = null;
    if (isOuter) {
      try {
        const keyRaw = await client.readContract({
          address: factory,
          abi: geniusFactoryAbi,
          functionName: 'poolKeyFor',
          args: [tokenAddress],
        });
        poolKey = parsePoolKey(keyRaw);
      } catch {
        poolKey = null;
      }
    }

    return {
      phase,
      isInner,
      isOuter,
      tradeable: isInner || isOuter,
      curve: launch.curve,
      pairToken: launch.pairToken,
      quoteRouterToken: toQuoteRouterToken(launch.pairToken, isNativeQuote),
      isNativeQuote,
      poolFee: launch.poolFee,
      tickSpacing: launch.tickSpacing,
      creatorTaxBps: launch.creatorTaxBps,
      graduationThreshold: launch.graduationThreshold,
      memeHook: poolKey?.hooks && !isZero(poolKey.hooks) ? poolKey.hooks : getConfiguredGeniusMemeHook(),
      poolKey,
    } satisfies GeniusTradeState;
  });
}

export async function getGeniusTradeState(tokenAddress: Address, opts?: GeniusTradeStateOptions): Promise<GeniusTradeState | null> {
  const key = tokenAddress.toLowerCase();
  const force = opts?.force === true;
  const cached = geniusTradeStateCache.get(key);
  if (!force && cached) {
    const ttlMs = cached.value?.isInner ? GENIUS_TRADE_STATE_INNER_TTL_MS : GENIUS_TRADE_STATE_OUTER_TTL_MS;
    if (Date.now() - cached.ts < ttlMs) return cached.value;
  }
  const inflight = geniusTradeStateInFlight.get(key);
  if (!force && inflight) return await inflight;
  const p = loadGeniusTradeState(tokenAddress).finally(() => {
    geniusTradeStateInFlight.delete(key);
  });
  geniusTradeStateInFlight.set(key, p);
  const resolved = await p;
  geniusTradeStateCache.set(key, { ts: Date.now(), value: resolved });
  return resolved;
}

function quoteBuyLocal(input: {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellable: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  snipeBps: bigint;
  quoteIn: bigint;
}): GeniusBuyQuote {
  const { quoteReserve: Q, tokenReserve: T, sellable, feeBps, creatorTaxBps, quoteIn } = input;
  let snipeBps = input.snipeBps;
  if (snipeBps !== 0n) {
    const cap = BPS_DENOM - feeBps - creatorTaxBps - 100n;
    if (cap < 0n) snipeBps = 0n;
    else if (snipeBps > cap) snipeBps = cap;
  }

  let spent = quoteIn;
  let fee = spent * feeBps / BPS_DENOM;
  let tax = spent * creatorTaxBps / BPS_DENOM;
  let snipe = spent * snipeBps / BPS_DENOM;
  let net = spent - fee - tax - snipe;
  if (net <= 0n || Q <= 0n || T <= 0n) {
    return { tokensOut: 0n, spent: 0n, fee: 0n, tax: 0n, snipe: 0n, refund: quoteIn };
  }

      let tokensOut = net * T / (Q + net);
  if (sellable > 0n && tokensOut > sellable) {
    tokensOut = sellable;
    const reserved = T > sellable ? (T - sellable) : 0n;
    if (reserved <= 0n) {
      return { tokensOut: 0n, spent: 0n, fee: 0n, tax: 0n, snipe: 0n, refund: quoteIn };
    }
    // last buy of the curve: partial fill + refund
    net = sellable * Q / reserved + 1n;
    const denom = BPS_DENOM - feeBps - creatorTaxBps - snipeBps;
    if (denom <= 0n) {
      return { tokensOut: 0n, spent: 0n, fee: 0n, tax: 0n, snipe: 0n, refund: quoteIn };
    }
    // ceil(net * BPS / denom)
    const needed = (net * BPS_DENOM + denom - 1n) / denom;
    spent = needed < quoteIn ? needed : quoteIn;
    fee = spent * feeBps / BPS_DENOM;
    tax = spent * creatorTaxBps / BPS_DENOM;
    snipe = spent * snipeBps / BPS_DENOM;
  }

  return {
    tokensOut,
    spent,
    fee,
    tax,
    snipe,
    refund: quoteIn - spent,
  };
}

export async function quoteGeniusBuyDetailed(
  tokenAddress: Address,
  quoteIn: bigint,
  opts?: GeniusTradeStateOptions & { snipeRecipient?: Address },
): Promise<GeniusBuyQuote | null> {
  if (quoteIn <= 0n) return null;
  const state = await getGeniusTradeState(tokenAddress, opts);
  if (!state?.tradeable) return null;

  if (state.isInner) {
    return await withBnbRead('genius.quote.buy', async (client) => {
      const recipient = opts?.snipeRecipient ?? getConfiguredDagobangRouter();
      const [reserves, sellable, feeBps, creatorTaxBps, snipeBps] = await Promise.all([
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'getReserves' }) as Promise<[bigint, bigint]>,
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'sellableTokens' }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'feeBps' }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'creatorTaxBps' }).catch(() => 0n) as Promise<bigint>,
        client.readContract({
          address: state.curve,
          abi: geniusCurveAbi,
          functionName: 'currentSnipeTaxBps',
          args: [recipient],
        }).catch(() => 0n) as Promise<bigint>,
      ]);
      return quoteBuyLocal({
        quoteReserve: BigInt(reserves[0] ?? 0n),
        tokenReserve: BigInt(reserves[1] ?? 0n),
        sellable: BigInt(sellable ?? 0n),
        feeBps: BigInt(feeBps ?? 0n),
        creatorTaxBps: BigInt(creatorTaxBps ?? 0n),
        snipeBps: BigInt(snipeBps ?? 0n),
        quoteIn,
      });
    });
  }

  if (state.isOuter && state.poolKey) {
    const amountOut = await quoteGeniusInfinityExactIn({
      poolKey: state.poolKey,
      tokenIn: state.quoteRouterToken,
      tokenOut: tokenAddress,
      amountIn: quoteIn,
    });
    if (amountOut <= 0n) return null;
    return { tokensOut: amountOut, spent: quoteIn, fee: 0n, tax: 0n, snipe: 0n, refund: 0n };
  }

  return null;
}

export async function quoteGeniusBuy(
  tokenAddress: Address,
  quoteIn: bigint,
  opts?: GeniusTradeStateOptions & { snipeRecipient?: Address },
): Promise<bigint> {
  const quoted = await quoteGeniusBuyDetailed(tokenAddress, quoteIn, opts);
  return quoted?.tokensOut ?? 0n;
}

export async function quoteGeniusSell(
  tokenAddress: Address,
  tokensIn: bigint,
  opts?: GeniusTradeStateOptions,
): Promise<bigint> {
  if (tokensIn <= 0n) return 0n;
  const state = await getGeniusTradeState(tokenAddress, opts);
  if (!state?.tradeable) return 0n;

  if (state.isInner) {
    return await withBnbRead('genius.quote.sell', async (client) => {
      const [reserves, feeBps, creatorTaxBps] = await Promise.all([
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'getReserves' }) as Promise<[bigint, bigint]>,
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'feeBps' }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: state.curve, abi: geniusCurveAbi, functionName: 'creatorTaxBps' }).catch(() => 0n) as Promise<bigint>,
      ]);
      const quoteReserve = BigInt(reserves[0] ?? 0n);
      const tokenReserve = BigInt(reserves[1] ?? 0n);
      if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
      const gross = tokensIn * quoteReserve / (tokenReserve + tokensIn);
      const fee = gross * BigInt(feeBps) / BPS_DENOM;
      const tax = gross * BigInt(creatorTaxBps) / BPS_DENOM;
      const out = gross - fee - tax;
      return out > 0n ? out : 0n;
    });
  }

  if (state.isOuter && state.poolKey) {
    return await quoteGeniusInfinityExactIn({
      poolKey: state.poolKey,
      tokenIn: tokenAddress,
      tokenOut: state.quoteRouterToken,
      amountIn: tokensIn,
    });
  }

  return 0n;
}

async function quoteGeniusInfinityExactIn(input: {
  poolKey: GeniusPoolKey;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}): Promise<bigint> {
  if (input.amountIn <= 0n) return 0n;
  const zeroForOne = input.tokenIn.toLowerCase() < input.tokenOut.toLowerCase();
  try {
    return await withBnbRead('genius.quote.infinity', async (client) => {
      const result = await client.simulateContract({
        address: GENIUS_CL_QUOTER,
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
      });
      const amountOut = Array.isArray(result.result) ? result.result[0] : result.result;
      return BigInt(amountOut ?? 0n);
    });
  } catch {
    return 0n;
  }
}

/** Genius docs: minTokensOut = (quoteIn × tokensOut / spent) × (10000 − s) / 10000 */
export function applyGeniusBuySlippage(quoteIn: bigint, quoted: GeniusBuyQuote, slippageBps: bigint): bigint {
  if (quoted.tokensOut <= 0n || quoted.spent <= 0n || quoteIn <= 0n) return 0n;
  return (quoteIn * quoted.tokensOut / quoted.spent) * (BPS_DENOM - slippageBps) / BPS_DENOM;
}

export function buildGeniusBuyDesc(input: {
  state: GeniusTradeState;
  tokenOut: Address;
  minOut: bigint;
}): SwapDescLike {
  const { state, tokenOut, minOut } = input;
  const tokenIn = state.quoteRouterToken;
  if (state.isInner) {
    return getRouterSwapDesc({
      swapType: SwapType.GENIUS_BUY,
      tokenIn,
      tokenOut,
      poolAddress: state.curve,
      fee: 0,
      data: minOut > 0n ? encodeGeniusMinOut(minOut) : '0x',
    });
  }
  if (state.isOuter && state.poolKey) {
    return getRouterSwapDesc({
      swapType: SwapType.PANCAKE_INFINITY_EXACT_IN,
      tokenIn,
      tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee: state.poolKey.fee,
      tickSpacing: state.tickSpacing,
      hooks: state.poolKey.hooks,
      poolManager: state.poolKey.poolManager,
      parameters: state.poolKey.parameters,
    });
  }
  throw new Error('Genius token is not tradeable in the current phase');
}

export function buildGeniusSellDesc(input: {
  state: GeniusTradeState;
  tokenIn: Address;
  minOut: bigint;
}): SwapDescLike {
  const { state, tokenIn, minOut } = input;
  const tokenOut = state.quoteRouterToken;
  if (state.isInner) {
    return getRouterSwapDesc({
      swapType: SwapType.GENIUS_SELL,
      tokenIn,
      tokenOut,
      poolAddress: state.curve,
      fee: 0,
      data: minOut > 0n ? encodeGeniusMinOut(minOut) : '0x',
    });
  }
  if (state.isOuter && state.poolKey) {
    return getRouterSwapDesc({
      swapType: SwapType.PANCAKE_INFINITY_EXACT_IN,
      tokenIn,
      tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee: state.poolKey.fee,
      tickSpacing: state.tickSpacing,
      hooks: state.poolKey.hooks,
      poolManager: state.poolKey.poolManager,
      parameters: state.poolKey.parameters,
    });
  }
  throw new Error('Genius token is not tradeable in the current phase');
}
