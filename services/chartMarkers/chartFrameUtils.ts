const GMGN_CHAIN_ALIASES: Record<string, string> = {
  rh: 'robinhood',
  bnb: 'bsc',
  solana: 'sol',
  hyperevm: 'hyper',
};

export const normalizeGmgnChartChain = (raw: string) => {
  const key = String(raw || '').trim().toLowerCase();
  return GMGN_CHAIN_ALIASES[key] || key;
};

export const normalizeGmgnTokenSlug = (raw: string) => {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!text.includes('_')) return text;
  try {
    return decodeURIComponent(text.split('_').pop() || text);
  } catch {
    return text.split('_').pop() || text;
  }
};

export type ChartFrameRouteToken = { chain: string; address: string };

export const parseChartFrameRouteToken = (frame: HTMLIFrameElement | null | undefined): ChartFrameRouteToken | null => {
  if (!frame) return null;
  try {
    const raw = frame.getAttribute('data-widget-options');
    if (typeof raw !== 'string' || !raw.length || raw.length > 8192) return null;
    const symbols = new URLSearchParams(raw).getAll('symbol');
    if (symbols.length !== 1) return null;
    const parts = symbols[0].split('/').filter(Boolean);
    if (parts.length < 3) return null;
    const chain = normalizeGmgnChartChain(parts[0]);
    const address = normalizeGmgnTokenSlug(parts[1]);
    if (!chain || !address) return null;
    return { chain, address };
  } catch {
    return null;
  }
};

const CHART_IFRAME_SELECTOR = 'iframe[title="Financial Chart"], iframe[title="TradingView"], [data-sentry-component="TradingView"] iframe';

const isChartIframe = (frame: HTMLIFrameElement) => {
  const title = String(frame.title || '');
  const inTradingView = Boolean(frame.closest?.('[data-sentry-component="TradingView"]'));
  return title === 'Financial Chart' || title === 'TradingView' || inTradingView;
};

export const collectChartIframes = (): HTMLIFrameElement[] => {
  const found = new Set<HTMLIFrameElement>();
  const scanRoot = (root: Document | ShadowRoot | Element) => {
    try {
      root.querySelectorAll(CHART_IFRAME_SELECTOR).forEach((node) => {
        if (node instanceof HTMLIFrameElement && isChartIframe(node)) found.add(node);
      });
    } catch {
    }
    const elements = root instanceof Document
      ? root.documentElement.querySelectorAll('*')
      : root.querySelectorAll('*');
    elements.forEach((el) => {
      if (el.shadowRoot) scanRoot(el.shadowRoot);
    });
  };
  scanRoot(document);
  return [...found];
};
