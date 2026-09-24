export type DexPoolPreferHint = 'v2' | 'v3' | 'v4' | null;

export function isBytes32PoolId(value?: string | null): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

/** Non-Pancake bytes32 V4 (openfour, etc.) — must not go through Infinity poolIdToPoolKey. */
export function isNonPancakeInfinityV4DexText(value?: string | null): boolean {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    if (text.includes('openfour') || text.includes('open_four') || text.includes('4stock')) return true;
    if (text.includes('geniusfun') || text.includes('genius_fun')) return true;
    if (text.includes('fourmeme') || text.includes('flap')) return true;
    return false;
}

/** Pancake Infinity only — not Uniswap V4 / 4Stock V4 / bare bytes32. */
export function isPancakeInfinityDexText(value?: string | null): boolean {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    if (text.includes('infinity')) return true;
    if (text.includes('pancake') && text.includes('v4')) return true;
    if (/\bpcs\b/.test(text) && text.includes('v4')) return true;
    return false;
}

export function classifyDexPoolHint(input: {
    exchange?: string | null;
    poolType?: string | null;
    dexType?: string | null;
    poolAddress?: string | null;
}): DexPoolPreferHint {
    const text = [input.exchange, input.poolType, input.dexType]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join(' ');
    if (isPancakeInfinityDexText(text)) return 'v4';
    const fromText = getDexPoolPrefer(text);
    if (fromText === 'v3' || fromText === 'v2') return fromText;
    // mutil_window Infinity hops use bytes32 poolId (e.g. 天才/GENIUS) without
    // "infinity" in exchange text — shape alone is the signal when not openfour.
    if (isBytes32PoolId(input.poolAddress) && !isNonPancakeInfinityV4DexText(text)) {
        return 'v4';
    }
    return null;
}

export function getDexPoolPrefer(dex_type: string | undefined): string | undefined {
    const lowered = dex_type?.toLowerCase();
    if (!lowered) return undefined;
    if (lowered.includes('v4') || lowered.includes('infinity')) return 'v4';
    if (lowered === 'pancake_swap_v3' || lowered === 'uniswap_v3' || lowered.includes('v3') || lowered.includes('clmm')) return 'v3';
    if (lowered === 'pancake_swap' || lowered === 'uniswap') return 'v2';
    return undefined;
}

export function parseGweiToWei(value: string): bigint {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return 0n;
    const intPart = match[1] || '0';
    const fracPartRaw = match[2] || '';
    const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
    const intBig = BigInt(intPart);
    const fracBig = BigInt(fracPadded);
    return intBig * 1000000000n + fracBig;
}
