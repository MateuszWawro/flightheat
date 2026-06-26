/* FlightHeat — Analytics tab logic */
/* globals L, Chart */

(function () {
  'use strict';

  // ── Region presets ─────────────────────────────────────────────────────────
  const REGIONS = {
    polska:        { label: '🇵🇱 Polska',         lamin: 49,   lamax: 55,   lomin: 14,   lomax: 24.5, center: [52, 19.5],  zoom: 6 },
    europe:        { label: '🌍 Europa',           lamin: 34,   lamax: 72,   lomin: -12,  lomax: 42,   center: [50, 15],    zoom: 4 },
    centraleurope: { label: 'Europa Środkowa',     lamin: 45,   lamax: 56,   lomin: 8,    lomax: 28,   center: [50.5, 18],  zoom: 5 },
    trojmiasto:    { label: 'Trójmiasto',          lamin: 54.1, lamax: 54.7, lomin: 17.8, lomax: 19.0, center: [54.4, 18.4],zoom: 10 },
    elblag:        { label: 'Elbląg',              lamin: 53.9, lamax: 54.4, lomin: 19.0, lomax: 20.0, center: [54.15, 19.4],zoom: 10 },
  };

  // ── Legend config ──────────────────────────────────────────────────────────
  const LEGENDS = {
    density:  { gradient: 'linear-gradient(to right, #00bcd4, #ff9800, #f44336)', min: 'Rzadkie',  max: 'Gęste' },
    altitude: { gradient: 'linear-gradient(to right, #1a237e, #4fc3f7, #e1f5fe)', min: '0 m',      max: '13 000 m' },
    speed:    { gradient: 'linear-gradient(to right, #4a148c, #e040fb, #ff80ab)', min: '0 km/h',   max: '900 km/h' },
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let currentHours  = 24;
  let currentRegion = 'polska';
  let analyticsMap  = null;
  let heatLayer     = null;
  let activeHeatType = 'density';
  let heatRadius    = 20;
  let timelineChart = null;
  let countriesChart = null;
  let lastHeatRows  = [];

  // ── Init (called when tab becomes visible) ─────────────────────────────────
  function initAnalytics() {
    if (analyticsMap) return;

    analyticsMap = L.map('analytics-map', { zoomControl: true, preferCanvas: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(analyticsMap);

    const r = REGIONS[currentRegion];
    analyticsMap.setView(r.center, r.zoom);
  }

  // ── Fetch all analytics data ───────────────────────────────────────────────
  async function loadAnalytics() {
    const h = currentHours;
    const r = REGIONS[currentRegion];
    updateCollectorStatus();
    setAnalyticsStatus('Ładowanie danych…');

    try {
      const bboxQ = `&lamin=${r.lamin}&lamax=${r.lamax}&lomin=${r.lomin}&lomax=${r.lomax}`;
      const [stats, timeline, heatmap] = await Promise.all([
        fetch(`/api/history/stats?hours=${h}${bboxQ}`).then(r => r.json()),
        fetch(`/api/history/timeline?hours=${h}&interval=${h >= 168 ? 120 : h >= 24 ? 60 : 15}`).then(r => r.json()),
        fetch(`/api/history/heatmap?hours=${h}${bboxQ}`).then(r => r.json())
      ]);

      renderStats(stats);
      renderTimeline(timeline);
      lastHeatRows = heatmap;
      renderHeatmap(heatmap);
      renderLegend(activeHeatType);
      renderCountries(stats.topCountries || []);
      updateHistoricalLabel();
      setAnalyticsStatus(`${r.label} · ${formatHours(h)} · ${stats.totalFlights.toLocaleString()} rek.`);
    } catch (err) {
      setAnalyticsStatus('Błąd: ' + err.message, true);
    }
  }

  function formatHours(h) {
    if (h < 24) return `${h}h`;
    if (h % 24 === 0) return `${h / 24}d`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  // ── Collector status ───────────────────────────────────────────────────────
  async function updateCollectorStatus() {
    try {
      const s = await fetch('/api/collector/status').then(r => r.json());
      const dot   = document.getElementById('collector-dot');
      const label = document.getElementById('collector-label');
      const time  = s.lastRun ? new Date(s.lastRun).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '—';
      dot.className = 'collector-dot ' + (s.lastRun ? 'active' : 'inactive');
      label.textContent = s.lastRun
        ? `Kolektor aktywny — ${time} (${s.totalRecords.toLocaleString()} rek.)`
        : 'Kolektor nieaktywny';
    } catch { /* silent */ }
  }

  // ── Stats cards ────────────────────────────────────────────────────────────
  function renderStats(s) {
    setText('astat-total',  s.totalFlights.toLocaleString());
    setText('astat-unique', s.uniqueAircraft.toLocaleString());
    setText('astat-alt',    s.avgAlt ? `${s.avgAlt.toLocaleString()} m` : '—');
    const peakTime = s.peakHour
      ? new Date(s.peakHour.time).toLocaleString('pl-PL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    setText('astat-peak', peakTime);
    if (s.peakHour) {
      const sub = document.getElementById('astat-peak-sub');
      if (sub) sub.textContent = `${s.peakHour.count} samolotów`;
    }
  }

  // ── Timeline chart ─────────────────────────────────────────────────────────
  function renderTimeline(rows) {
    const ctx = document.getElementById('timeline-chart');
    if (!ctx) return;

    const labels = rows.map(r => {
      const d = new Date(r.time);
      return d.toLocaleString('pl-PL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    });

    if (timelineChart) timelineChart.destroy();

    timelineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: rows.map(r => r.count),
          borderColor: '#4fc3f7',
          backgroundColor: 'rgba(79,195,247,0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: rows.length > 100 ? 0 : 2,
          pointHoverRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => ` ${ctx.parsed.y} samolotów` }
        }},
        scales: {
          x: { ticks: { color: '#6b7a99', maxTicksLimit: 10, maxRotation: 0 }, grid: { color: '#1e2d4a' } },
          y: { ticks: { color: '#6b7a99' }, grid: { color: '#1e2d4a' },
               title: { display: true, text: 'Liczba samolotów', color: '#6b7a99', font: { size: 11 } } }
        }
      }
    });
  }

  // ── Historical heatmap ─────────────────────────────────────────────────────
  function renderHeatmap(rows) {
    if (!analyticsMap) return;
    if (heatLayer) analyticsMap.removeLayer(heatLayer);
    if (!rows.length) return;

    const maxCount = Math.max(...rows.map(r => r.count));
    const maxAlt   = Math.max(...rows.map(r => r.avgAlt   || 0));
    const maxSpeed = Math.max(...rows.map(r => r.avgSpeed || 0));

    const configs = {
      density:  { pts: rows.map(r => [r.lat, r.lon, r.count                  / (maxCount || 1)]), gradient: { 0.4: '#00bcd4', 0.7: '#ff9800', 1: '#f44336' } },
      altitude: { pts: rows.map(r => [r.lat, r.lon, (r.avgAlt   || 0)        / (maxAlt   || 1)]), gradient: { 0.4: '#1a237e', 0.7: '#4fc3f7', 1: '#e1f5fe' } },
      speed:    { pts: rows.map(r => [r.lat, r.lon, (r.avgSpeed || 0)        / (maxSpeed || 1)]), gradient: { 0.4: '#4a148c', 0.7: '#e040fb', 1: '#ff80ab' } },
    };

    const cfg = configs[activeHeatType];
    heatLayer = L.heatLayer(cfg.pts, { radius: heatRadius, blur: Math.round(heatRadius * 0.75), maxZoom: 10, gradient: cfg.gradient });
    heatLayer.addTo(analyticsMap);
  }

  // ── Legend ─────────────────────────────────────────────────────────────────
  function renderLegend(type) {
    const bar   = document.getElementById('a-legend-bar');
    const minEl = document.getElementById('a-legend-min');
    const maxEl = document.getElementById('a-legend-max');
    if (!bar) return;
    const lg = LEGENDS[type] || LEGENDS.density;
    bar.style.background = lg.gradient;
    if (minEl) minEl.textContent = lg.min;
    if (maxEl) maxEl.textContent = lg.max;
  }

  // ── Countries bar chart ────────────────────────────────────────────────────
  function renderCountries(rows) {
    const ctx = document.getElementById('countries-chart');
    if (!ctx) return;
    if (countriesChart) countriesChart.destroy();
    if (!rows.length) return;

    countriesChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.country || 'Nieznany'),
        datasets: [{
          data: rows.map(r => r.count),
          backgroundColor: 'rgba(79,195,247,0.7)',
          borderColor: '#4fc3f7',
          borderWidth: 1,
          borderRadius: 3
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#6b7a99' }, grid: { color: '#1e2d4a' } },
          y: { ticks: { color: '#cdd6f4' }, grid: { color: '#1e2d4a' } }
        }
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function setAnalyticsStatus(msg, isError) {
    const el = document.getElementById('analytics-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'analytics-status' + (isError ? ' error' : '');
  }

  function updateHistoricalLabel() {
    const r  = REGIONS[currentRegion];
    const el = document.getElementById('historical-label');
    if (el) el.textContent = `${r.label} · ostatnie ${formatHours(currentHours)}`;
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  function wire() {
    // Region selector
    document.querySelectorAll('.aregion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.aregion-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRegion = btn.dataset.region;
        const r = REGIONS[currentRegion];
        if (analyticsMap) analyticsMap.flyTo(r.center, r.zoom, { duration: 0.8 });
        loadAnalytics();
      });
    });

    // Time slider
    const slider   = document.getElementById('time-slider');
    const sliderVal= document.getElementById('time-slider-val');
    if (slider) {
      slider.addEventListener('input', () => {
        currentHours = parseInt(slider.value);
        if (sliderVal) sliderVal.textContent = formatHours(currentHours);
      });
      slider.addEventListener('change', () => loadAnalytics());
    }

    // Refresh button
    document.getElementById('analytics-refresh')?.addEventListener('click', loadAnalytics);

    // Heat type toggle
    document.querySelectorAll('.aheat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.aheat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeHeatType = btn.dataset.type;
        renderLegend(activeHeatType);
        renderHeatmap(lastHeatRows);
      });
    });

    // Radius slider
    const radSlider = document.getElementById('a-radius');
    const radVal    = document.getElementById('a-radius-val');
    if (radSlider) {
      radSlider.addEventListener('input', () => {
        heatRadius = parseInt(radSlider.value);
        if (radVal) radVal.textContent = `${heatRadius}px`;
        renderHeatmap(lastHeatRows);
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.Analytics = { init: initAnalytics, load: loadAnalytics, wire };
})();
