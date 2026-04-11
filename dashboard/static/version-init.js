/**
 * Version check for dashboard (ES module). Uses shared script from /updates-assets/.
 * Loaded via import(`${BASE_PATH}/static/version-init.js`) from index.html so staging paths work.
 */
(async () => {
  try {
    const base = window.BASE_PATH || "";
    const { createIndicatorClickVersionCheck, showSimpleUpdateModal } = await import(
      `${base}/updates-assets/version-check.mjs`
    );
    const vc = createIndicatorClickVersionCheck({
      versionUrl: `${base}/api/version`,
      intervalMs: 30000,
      indicatorId: "dashboardUpdateIndicator",
      showModal: async () =>
        showSimpleUpdateModal({
          title: "New update available",
          message:
            "A new version of the dashboard is ready.\n\nRefreshing will reload the page and reset your current view.",
          confirmLabel: "Update now",
          cancelLabel: "Not now",
        }),
    });
    vc.initVersionCheck();
  } catch (e) {
    console.error("[dashboard version-check]", e);
  }
})();
