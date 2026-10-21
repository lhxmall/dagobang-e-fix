/**
 * Lightweight GMGN chart marker bridge (Tango-style: top frame postMessage → chart iframe MAIN).
 * Must NOT import @/utils/messaging or @/constants/chains — those pull viem into the content script bundle.
 */
import { browser } from 'wxt/browser';
import {
  collectChartIframes,
  parseChartFrameRouteToken,
} from '@/services/chartMarkers/chartFrameUtils';
import type { LimitOrderChartMarkerPayload } from '@/services/chartMarkers/limitOrderChartMarkers';
import { DAGOBANG_CHART_MARKERS_EVENT } from '@/services/chartMarkers/publishLimitOrderChartMarkers';

declare global {
  interface Window {
    __dagobangChartMarkersBridge?: boolean;
  }
}

const CHART_PROBE_ID_MAX_CHARS = 128;
const CHART_BRIDGE_SCRIPT_ATTR = 'data-dagobang-chart-bridge-script';
const CHART_BRIDGE_SCRIPT_URL = 'content-scripts/chart-markers-frame.js';

type MarkerPayload = LimitOrderChartMarkerPayload;

const isMarkerPayload = (value: unknown): value is MarkerPayload => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as MarkerPayload).markers)
);

export function installGmgnChartMarkersBridge() {
  if (window !== window.top || window.__dagobangChartMarkersBridge) return;
  if (!/gmgn\.ai/i.test(window.location.hostname)) return;
  window.__dagobangChartMarkersBridge = true;
  try {
    document.documentElement?.setAttribute('data-dagobang-chart-markers-bridge', '1');
    const probe = document.createElement('script');
    probe.setAttribute('data-dagobang-chart-markers-bridge', '1');
    probe.textContent = 'window.__dagobangChartMarkersBridge=true;';
    (document.head || document.documentElement).appendChild(probe);
    probe.remove();
  } catch {
    // page MAIN probe optional
  }

  let frameGeneration = 0;
  const frameGenerations = new WeakMap<HTMLIFrameElement, number>();
  const frameProbeIds = new WeakMap<HTMLIFrameElement, string>();
  const frameReadyProbeIds = new WeakMap<HTMLIFrameElement, string>();
  const markerPayloads = new WeakMap<HTMLIFrameElement, string>();
  let latestPayload: MarkerPayload = { chain: '', tokenAddress: '', markers: [] };
  let probeSequence = 0;
  const registeredFrames = new WeakSet<HTMLIFrameElement>();

  let bridgeScriptUrl = '';
  try {
    bridgeScriptUrl = browser.runtime.getURL(CHART_BRIDGE_SCRIPT_URL);
  } catch {
    bridgeScriptUrl = '';
  }

  const chartLinesEnabled = () => {
    const settings = (window as unknown as { __DAGOBANG_SETTINGS__?: { ui?: { limitOrderChartLinesEnabled?: boolean } } })
      .__DAGOBANG_SETTINGS__;
    return settings?.ui?.limitOrderChartLinesEnabled !== false;
  };

  const injectMainBridge = (frame: HTMLIFrameElement) => {
    if (!bridgeScriptUrl) return;
    try {
      const doc = frame.contentDocument;
      const view = frame.contentWindow as (Window & { __dagobangChartBridge?: boolean }) | null;
      if (!doc || view?.__dagobangChartBridge) return;
      if (doc.querySelector(`script[${CHART_BRIDGE_SCRIPT_ATTR}]`)) return;
      const script = doc.createElement('script');
      script.setAttribute(CHART_BRIDGE_SCRIPT_ATTR, '1');
      script.src = bridgeScriptUrl;
      script.async = false;
      (doc.head || doc.documentElement).appendChild(script);
    } catch {
      // cross-origin — rely on extension content script + matchOriginAsFallback
    }
  };

  const chartAxisHint = (frame: HTMLIFrameElement): 'PRICE' | 'MARKET_CAP' | 'UNKNOWN' => {
    try {
      const raw = frame.getAttribute('data-widget-options');
      if (typeof raw !== 'string' || !raw.length) return 'UNKNOWN';
      const symbols = new URLSearchParams(raw).getAll('symbol');
      if (symbols.length !== 1) return 'UNKNOWN';
      const parts = symbols[0].split('/');
      if (parts.length === 3) return 'PRICE';
      if (parts.length === 4 && String(parts[3]).toUpperCase() === 'MCAP') return 'MARKET_CAP';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  };

  const deliveryContext = (frame: HTMLIFrameElement) => {
    const generation = frameGenerations.get(frame) ?? 0;
    const probeId = frameReadyProbeIds.get(frame) || frameProbeIds.get(frame) || '';
    const routeToken = parseChartFrameRouteToken(frame);
    return {
      axisHint: chartAxisHint(frame),
      quoteUsd: 1,
      quoteCurrency: 'USD' as const,
      frameGeneration: generation > 0 ? generation : 0,
      probeId: probeId.length <= CHART_PROBE_ID_MAX_CHARS ? probeId : '',
      ...(routeToken ? { routeToken } : {}),
    };
  };

  const beginGeneration = (frame: HTMLIFrameElement) => {
    frameGeneration += 1;
    frameGenerations.set(frame, frameGeneration);
    frameProbeIds.delete(frame);
    frameReadyProbeIds.delete(frame);
    markerPayloads.delete(frame);
    return frameGeneration;
  };

  const probeFrame = (frame: HTMLIFrameElement) => {
    injectMainBridge(frame);
    const target = frame.contentWindow;
    if (!target) return;
    const generation = frameGenerations.get(frame) ?? beginGeneration(frame);
    probeSequence += 1;
    const probeId = `dagobang:${probeSequence}`;
    frameProbeIds.set(frame, probeId);
    target.postMessage({
      source: 'DAGOBANG_CHART_PARENT',
      type: 'CHART_READY_PROBE',
      probeId,
      frameGeneration: generation,
    }, '*');
  };

  const deliver = (frames: HTMLIFrameElement[], force = false) => {
    const payload = latestPayload;
    const hasIdentity = Boolean(String(payload.chain || '').trim() && String(payload.tokenAddress || '').trim());
    const unscopedClear = payload.markers.length === 0 && !hasIdentity;
    if (!payload.markers.length && !hasIdentity && !unscopedClear) return;
    for (const frame of frames) {
      if (!frame.contentWindow) continue;
      injectMainBridge(frame);
      if (!frameGenerations.has(frame)) beginGeneration(frame);
      if (!frameReadyProbeIds.has(frame) && !frameProbeIds.has(frame)) probeFrame(frame);
      const context = deliveryContext(frame);
      if (!context.probeId || context.frameGeneration <= 0) continue;
      const signature = JSON.stringify({ context, payload });
      if (!force && markerPayloads.get(frame) === signature) continue;
      markerPayloads.set(frame, signature);
      frame.contentWindow.postMessage({
        source: 'DAGOBANG_CHART_PARENT',
        type: 'CHART_MARKERS',
        context,
        payload,
      }, '*');
    }
  };

  const registerFrame = (frame: HTMLIFrameElement) => {
    if (registeredFrames.has(frame)) return;
    registeredFrames.add(frame);
    beginGeneration(frame);
    probeFrame(frame);
    frame.addEventListener('load', () => {
      beginGeneration(frame);
      probeFrame(frame);
      deliver([frame], true);
    });
  };

  const applyUiPayload = (detail: unknown) => {
    if (!chartLinesEnabled()) {
      latestPayload = { chain: '', tokenAddress: '', markers: [] };
    } else if (isMarkerPayload(detail)) {
      latestPayload = detail;
    }
    const frames = collectChartIframes();
    for (const frame of frames) registerFrame(frame);
    deliver(frames, true);
  };

  const repushLatest = () => {
    const frames = collectChartIframes();
    if (!frames.length) return;
    for (const frame of frames) {
      if (!registeredFrames.has(frame)) registerFrame(frame);
    }
    deliver(frames, false);
  };

  window.addEventListener(DAGOBANG_CHART_MARKERS_EVENT, (event) => {
    applyUiPayload((event as CustomEvent<MarkerPayload>).detail);
  });

  window.addEventListener('message', (event) => {
    if (event.data?.source !== 'DAGOBANG_CHART' || event.data?.type !== 'READY') return;
    const frame = collectChartIframes().find((f) => f.contentWindow === event.source);
    if (!frame) return;
    const probeId = typeof event.data.probeId === 'string' ? event.data.probeId : '';
    const generation = Number(event.data.frameGeneration ?? 0);
    if (probeId) frameReadyProbeIds.set(frame, probeId);
    if (generation > 0) frameGenerations.set(frame, generation);
    deliver([frame], true);
  });

  const observer = new MutationObserver(() => repushLatest());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.setInterval(repushLatest, 2000);
}
