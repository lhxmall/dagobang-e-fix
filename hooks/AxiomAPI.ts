import { getAxiomLaunchpad } from "@/constants/launchpad";
import { TokenInfo } from "@/types/token";
import { ChainId } from "@/constants/chains/chainId";
import { chainNames, getChainIdByName } from "@/constants/chains/chainName";
import { getNativeSymbol } from "@/constants/chains";
import { resolveRouteTokenLabel } from "@/utils/quoteTokenLabels";

export interface AxiomPairInfoResponse {
  status: string;
  data: AxiomPairPayload;
}

type AxiomPairExtra = {
  migratedFrom?: string | null;
  migratedTo?: string | null;
} | null;

export type AxiomPairPayload = {
  pairAddress?: string;
  factory?: string;
  token0?: string;
  token1?: string;
  fee?: number;
  protocol?: string;
  displayProtocol?: string;
  tokenAddress?: string;
  quoteTokenAddress?: string;
  decimals?: number;
  tokenDecimals?: number;
  tokenName?: string;
  tokenTicker?: string;
  tokenImage?: string;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  discord?: string | null;
  extra?: AxiomPairExtra;
  [key: string]: unknown;
};

export class AxiomAPI {
  private static pairInfoBase(chainId: number): string | null {
    switch (chainId) {
      case ChainId.SOL:
        return "https://api10.axiom.trade";
      case ChainId.BNB:
        return "https://api2-bnb.axiom.trade";
      case ChainId.ETH:
        return "https://api2-eth.axiom.trade";
      case ChainId.RH:
        return "https://api2-robinhood.axiom.trade";
      case ChainId.HYPER:
        return "https://api2-hyper.axiom.trade";
      default:
        return null;
    }
  }

  private static async makeRequest(url: string, options: RequestInit): Promise<Response> {
    const headers = { ...options.headers } as Record<string, string>;

    if (options.method === "POST" && options.body) {
      headers["content-length"] = new Blob([options.body as string]).size.toString();
    }

    const requestOptions: RequestInit = {
      ...options,
      headers,
      credentials: "include",
      mode: "cors",
    };

    try {
      return await fetch(url, requestOptions);
    } catch (error) {
      console.error("Request failed:", error);
      throw error;
    }
  }

  private static getHeaders(): HeadersInit {
    const cookieValue = typeof document !== "undefined" ? document.cookie : "";
    return {
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "zh-CN,zh;q=0.9,ru;q=0.8",
      "content-type": "application/json",
      cookie: cookieValue,
      origin: "https://axiom.trade",
      referer: "https://axiom.trade/",
      "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "Windows",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    };
  }

  static readPageTokenLabel(): string | null {
    if (typeof document === "undefined") return null;
    const texts: string[] = [
      String(document.title || ""),
      String(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || ""),
      String(document.querySelector("h1")?.textContent || ""),
    ];
    for (const raw of texts) {
      const label = this.parseTickerFromText(raw);
      if (label) return label;
    }
    return null;
  }

  private static parseTickerFromText(raw: string): string | null {
    const title = String(raw || "").trim();
    if (!title) return null;
    const head = (title.split("|")[0] || "").trim();
    const name = head.replace(/\s+[↑↓].*$/u, "").replace(/\s+\$[\d.].*$/, "").trim();
    if (!name || name.length > 24) return null;
    if (/^axiom/i.test(name)) return null;
    if (/^0x/i.test(name)) return null;
    if (/discover|pulse|trackers|login/i.test(name)) return null;
    return name;
  }

  static tokenInfoFromPairPayload(chain: string, pair: AxiomPairPayload): TokenInfo | null {
    const chainId = getChainIdByName(chain);
    if (!Number.isFinite(chainId) || chainId <= 0) return null;
    const nested = pair.token && typeof pair.token === "object" ? (pair.token as Record<string, unknown>) : null;
    const pick = (...vals: unknown[]) => {
      for (const val of vals) {
        if (typeof val === "string" && val.trim()) return val.trim();
      }
      return "";
    };
    const mint = pick(pair.tokenAddress, pair.address, nested?.tokenAddress, nested?.address, nested?.mint);
    if (!mint) return null;
    const name = pick(pair.tokenName, pair.name, nested?.tokenName, nested?.name);
    const ticker = pick(pair.tokenTicker, pair.symbol, pair.ticker, nested?.tokenTicker, nested?.symbol, nested?.ticker);
    const pageLabel = this.readPageTokenLabel();
    const displayName = name || ticker || pageLabel;
    const displayTicker = ticker || name || pageLabel;
    if (!displayName && !displayTicker) return null;
    const decimalsRaw = Number(pair.tokenDecimals ?? pair.decimals);
    const decimalsFallback = chainId === ChainId.SOL ? 6 : 18;
    const decimals =
      Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 36 ? decimalsRaw : decimalsFallback;
    const pairAddress = typeof pair.pairAddress === "string" && pair.pairAddress ? pair.pairAddress : "";
    const quoteAddress = typeof pair.quoteTokenAddress === "string" ? pair.quoteTokenAddress : "";
    const extra = pair.extra && typeof pair.extra === "object" ? pair.extra : null;
    const migrated = !!(extra?.migratedFrom || extra?.migratedTo);
    const launchpad = getAxiomLaunchpad(pair);
    const chainName = chainNames[chainId] || "bsc";
    const quoteSymbol =
      chainId === ChainId.SOL && !quoteAddress
        ? "SOL"
        : resolveRouteTokenLabel({
            chainId,
            address: quoteAddress,
            fallbackSymbol: getNativeSymbol(chainId),
          });
    return {
      chain: chainName,
      address: mint,
      name: displayName,
      symbol: displayTicker,
      decimals,
      logo: typeof pair.tokenImage === "string" ? pair.tokenImage : "",
      launchpad,
      launchpad_progress: 0,
      launchpad_platform: launchpad,
      launchpad_status: migrated ? 1 : 0,
      quote_token: quoteSymbol,
      quote_token_address: quoteAddress,
      pool_pair: pairAddress,
      biggest_pool_address: pairAddress || undefined,
      website: pair.website || undefined,
      twitterUrl: pair.twitter || undefined,
      telegramUrl: pair.telegram || undefined,
      discordUrl: pair.discord || undefined,
    };
  }

  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const chainId = getChainIdByName(chain);
    const base = this.pairInfoBase(chainId);
    if (!base || !address) {
      if (!base) console.warn(`AxiomAPI: Chain ${chain} not supported`);
      return null;
    }
    const params = new URLSearchParams({ pairAddress: address });
    if (chainId === ChainId.SOL) params.set("v", "2");
    const url = `${base}/pair-info?${params.toString()}`;
    try {
      const response = await this.makeRequest(url, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!response.ok) return null;
      const result: unknown = await response.json();
      const payload = this.unwrapPairPayload(result);
      if (!payload) return null;
      return this.tokenInfoFromPairPayload(chain, payload);
    } catch (error) {
      console.error("Failed to fetch token info from Axiom:", error);
      return null;
    }
  }

  private static unwrapPairPayload(result: unknown): AxiomPairPayload | null {
    if (!result || typeof result !== "object") return null;
    const rec = result as Record<string, unknown>;
    if (rec.status === "Success" && rec.data && typeof rec.data === "object") {
      return rec.data as AxiomPairPayload;
    }
    if (typeof rec.tokenAddress === "string") {
      return rec as AxiomPairPayload;
    }
    return null;
  }
}

export default AxiomAPI;
