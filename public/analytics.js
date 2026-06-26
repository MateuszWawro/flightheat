/* FlightHeat — Analytics tab logic */
/* globals L, Chart */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let currentHours = 24;
  let analyticsMap = null;
  let heatLayer = null;
  let activeHeatType = 'density';
  let timelineChart = null;
  let countriesChart = null;

  // ── Init (called when tab becomes visible) ─────────────────────────────────
  function initAnalytics() {
    if (analyticsMap) return; // already initialised

    analyticsMap = L.map('analytics-map', { zoomControl: true, preferCanvas: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(analyticsMap);
    analyticsMap.setView([52, 19.5], 6);
  }

  // ── Fetch all analytics data ───────────────────────────────────────────────
  async function loadAnalytics() {
    const h = currentHours;
    updateCollectorStatus();

    setAnalyticsStatus('Ładowanie danych…');

    try {
      const [stats, timeline, heatmap] = await Promise.all([
        fetch(`/api/history/stats?hours=${h}`).then(r => r.json()),
        fetch(`/api/history/timeline?hours=${h}&interval=${h >= 168 ? 120 : h >= 24 ? 60 : 15}`).then(r => r.json()),
        fetch(`/api/history/heatmap?hours=${h}`).then(r => r.json())
      ]);

      renderStats(stats);
      renderTimeline(timeline);
      renderHeatmap(heatmap);
      renderCountries(stats.topCountries || []);
      setAnalyticsStatus(`Dane z ostatnich ${formatHours(h)} — ${stats.totalFlights.toLocaleString()} rekordów`);
    } catch (err) {
      setAnalyticsStatus('Błąd ładowania danych: ' + err.message, true);
    }
  }

  function formatHours(h) {
    if (h < 24) return `${h}h`;
    return `${h / 24}d`;
  }

  // ── Collector status ───────────────────────────────────────────────────────
  async function updateCollectorStatus() {
    try {
      const s = await fetch('/api/collector/status').then(r => r.json());
      const dot = document.getElementById('collector-dot');
      const label = document.getElementById('collector-label');
      const time = s.lastRun ? new Date(s.lastRun).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '—';
      dot.className = 'collector-dot ' + (s.lastRun ? 'active' : 'inactive');
      label.textContent = s.lastRun
        ? `Zbieranie aktywne — ostatni snapshot: ${time} (${s.totalRecords.toLocaleString()} rek.)`
        : 'Zbieranie nieaktywne';
    } catch {
      // silent
    }
  }

  // ── Stats cards ────────────────────────────────────────────────────────────
  function renderStats(s) {
    setText('astat-total', s.totalFlights.toLocaleString());
    setText('astat-unique', s.uniqueAircraft.toLocaleString());
    setText('astat-alt', s.avgAlt ? `${s.avgAlt.toLocaleString()} m` : '—');
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
    const data = rows.map(r => r.count);

    if (timelineChart) timelineChart.destroy();

    timelineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
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
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: '#6b7a99', maxTicksLimit: 10, maxRotation: 0 },
            grid: { color: '#1e2d4a' }
          },
          y: {
            ticks: { color: '#6b7a99' },
            grid: { color: '#1e2d4a' },
            title: { display: true, text: 'Liczba samolotów', color: '#6b7a99', font: { size: 11 } }
          }
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
    const maxAlt   = Math.max(...rows.map(r => r.avgAlt || 0));
    const maxSpeed = Math.max(...rows.map(r => r.avgSpeed || 0));

    const configs = {
      density: { pts: rows.map(r => [r.lat, r.lon, r.count / maxCount]),     gradient: { 0.4: '#00bcd4', 0.7: '#ff9800', 1: '#f44336' } },
      altitude: { pts: rows.map(r => [r.lat, r.lon, (r.avgAlt || 0) / (maxAlt || 1)]),   gradient: { 0.4: '#1a237e', 0.7: '#4fc3f7', 1: '#e1f5fe' } },
      speed:    { pts: rows.map(r => [r.lat, r.lon, (r.avgSpeed || 0) / (maxSpeed || 1)]), gradient: { 0.4: '#4a148c', 0.7: '#e040fb', 1: '#ff80ab' } }
    };

    const cfg = configs[activeHeatType];
    heatLayer = L.heatLayer(cfg.pts, { radius: 20, blur: 15, maxZoom: 10, gradient: cfg.gradient });
    heatLayer.addTo(analyticsMap);
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

  // ── Event wiring (called after DOM ready) ──────────────────────────────────
  function wire() {
    // Time range pills
    document.querySelectorAll('.time-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.time-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentHours = parseInt(btn.dataset.hours);
        updateHistoricalLabel();
        loadAnalytics();
      });
    });

    // Refresh button
    document.getElementById('analytics-refresh')?.addEventListener('click', loadAnalytics);

    // Heat type toggle
    document.querySelectorAll('.aheat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.aheat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeHeatType = btn.dataset.type;
        // Re-render heatmap with current data (lazy: just reload)
        fetch(`/api/history/heatmap?hours=${currentHours}`)
          .then(r => r.json())
          .then(renderHeatmap);
      });
    });
  }

  function updateHistoricalLabel() {
    const el = document.getElementById('historical-label');
    if (el) el.textContent = `Dane historyczne — ostatnie ${formatHours(currentHours)}`;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.Analytics = { init: initAnalytics, load: loadAnalytics, wire };
})();
