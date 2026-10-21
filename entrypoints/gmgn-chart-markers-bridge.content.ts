import { installGmgnChartMarkersBridge } from '@/services/chartMarkers/gmgnChartMarkersBridge';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*'],
  runAt: 'document_start',
  main() {
    if (window !== window.top) return;
    try {
      installGmgnChartMarkersBridge();
    } catch (error) {
      console.error('[dagobang.chart-markers.bridge.load.failed]', error);
    }
  },
});
