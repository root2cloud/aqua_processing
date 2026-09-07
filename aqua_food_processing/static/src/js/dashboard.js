/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";
import { Component, onMounted, onPatched, onWillUnmount, useState, useExternalListener, useRef } from "@odoo/owl";

import { KpiTile } from "../components/kpi_tile/kpi_tile";
import { ChartWidget } from "../components/chart_widget/chart_widget";
import { DrillPanel } from "../components/drill_panel/drill_panel";
import { FilterBar } from "../components/filter_bar/filter_bar";

class AquaDashboard extends Component {
    static template = "aqua_food_processing.DashboardMain";
    static components = { KpiTile, ChartWidget, DrillPanel, FilterBar };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.user = user;
        this.filters = { period: 'ytd', compare: 'none', customFrom: '', customTo: '' };
        // Hand-drawn SVG trend lines (receipt/weight/spend/QC trends) don't go
        // through Chart.js, so they need their own hover tooltip instead of
        // the native <title> attribute (which renders as a plain OS tooltip
        // that can't be styled - see svgTooltip/onSvgPointEnter below).
        this.svgTooltip = useState({ visible: false, x: 0, y: 0, text: '' });
        this.ui = useState({
            heroExpanded: false,
            // Bell (topbar): shakes continuously whenever there's an unseen
            // alert (QC hold/fail, cancelled receipt) and stops once the user
            // clicks it. alertsSignature remembers *which* alerts were last
            // seen so a fresh alert (or set of alerts) re-triggers the shake
            // even if the user had already dismissed an earlier one -- see
            // loadData()/onBellClick() below. notifOpen toggles the little
            // popover the bell opens, listing the same alerts as the
            // Overview tab's "Alerts & Notifications" card.
            alertsDismissed: true,
            alertsSignature: '',
            notifOpen: false,
            // Topbar search collapses down to just an icon (matching the
            // bell/export icon-buttons) and expands into the input on
            // click - see onSearchWrapClick/onSearchBlur below.
            searchExpanded: false,
            // Sliding highlight behind the active tab in the tab bar. Tabs
            // are variable-width (labels differ), so this can't be a fixed
            // 1/3-2/3 CSS transform like an evenly-split segmented control -
            // it's measured against the real DOM after every render, see
            // _updateTabGlider() below.
            tabGlider: { left: 0, width: 0, ready: false },
            // Briefly true right after the export button is clicked, purely
            // to duck its tooltip out of the way (the browser's own
            // :hover state otherwise keeps it glued on screen for as long
            // as the cursor stays put, which reads oddly right after a
            // click). See onExportDashboard() below.
            exportJustClicked: false,
            // Popover under the avatar - same pattern as the bell's
            // notifOpen. See onProfileButtonClick()/onProfileMenuClick()
            // below.
            profileOpen: false,
            // Dark mode toggle, shown as a switch inside the avatar
            // popover (see onToggleDarkMode() below). Persisted per-browser
            // in localStorage so it survives reloads/tab switches without
            // needing a server round-trip; restored in setup() below,
            // straight after this useState() call, so the very first
            // render already carries the right value (no light-mode flash).
            darkMode: false,
        });
        try {
            this.ui.darkMode = window.localStorage.getItem(AquaDashboard.DARK_MODE_STORAGE_KEY) === '1';
        } catch (e) {
            // localStorage can throw in locked-down/private-browsing
            // contexts - dark mode just falls back to off (its default)
            // rather than breaking the dashboard.
        }
        // The native browser scrollbar (page, drill panel, inner
        // table-scroll areas) can't be reached by CSS scoped under
        // .o_aqua_dashboard - only a class on <body> gets far enough up
        // the tree. Applied here for the initial render, flipped again in
        // onToggleDarkMode(), and removed on unmount so it never leaks
        // into whatever view/module the user navigates to next.
        this._syncBodyDarkScrollbar();
        onWillUnmount(() => document.body.classList.remove(AquaDashboard.DARK_SCROLLBAR_BODY_CLASS));
        // Clicking outside the open notifications popover closes it -- same
        // pattern FilterBar uses for its own dropdowns (.aqua-dropdown).
        useExternalListener(window, "click", (ev) => {
            if (!this.ui.notifOpen) return;
            if (!ev.target.closest(".aqua-bell-wrap")) {
                this.ui.notifOpen = false;
            }
        });
        // Same again for the profile popover.
        useExternalListener(window, "click", (ev) => {
            if (!this.ui.profileOpen) return;
            if (!ev.target.closest(".aqua-profile-wrap")) {
                this.ui.profileOpen = false;
            }
        });
        // Topbar quick-search: debounced query -> global_search() results,
        // rendered as a dropdown under the search box (see onSearchInput /
        // onSearchResultClick). Kept outside `state` since it has nothing
        // to do with the dashboard's own report data / period filters.
        this.search = useState({ query: '', results: [], isOpen: false, loading: false });
        this._searchDebounce = null;
        // Live weather for the plant location (see _loadWeather). Card
        // shows a fallback message if the request fails - e.g. no outbound
        // internet access from the browser - rather than silently reverting
        // to fake numbers.
        this.weather = useState({
            loading: true, error: false,
            tempC: null, humidity: null, windKph: null,
            code: null, isDay: true, updatedAt: '',
            locationLabel: AquaDashboard.FALLBACK_LOCATION_LABEL,
        });
        // Legend click -> show/hide toggle for the hand-drawn paired-bar
        // cards (Ordered vs received, Pass/Fail, Planned/Practical, etc).
        // These cards don't go through Chart.js, so they don't get its
        // "click a legend dot to hide that series" behaviour for free -
        // this reproduces the same interaction: keyed by
        // {chartId: {seriesKey: false}}, a series is visible unless its
        // entry is explicitly `false`.
        this.seriesVisibility = useState({});
        this.state = useState({
            isLoading: true,
            activeTab: 'overview',
            comparison_pct: {},
            comparison_label: '',
            total_receipts: 0,
            accepted_receipts: 0,
            cancelled_receipts: 0,
            rejection_rate: 0,
            total_weight_received: 0,
            active_vendor_count: 0,
            total_purchase_spend: 0,
            avg_price_per_kg: 0,
            qc_pass_rate: 0,
            on_time_dispatch_rate: 0,
            cold_room_utilization: [],
            receipts_by_species: [],
            qc_breakdown: [],
            shipment_breakdown: [],
            receipt_trend: [],
            trend_granularity_label: 'Weekly',
            receipt_status_breakdown: [],
            spend_by_vendor: [],
            weight_by_vendor: [],
            ordered_vs_received: [],
            recent_receipts_table: [],

            total_stock_on_hand: 0,
            stock_value: 0,
            current_stock_by_product: [],
            current_stock_by_location: [],
            purchase_to_stock_funnel: [],
            daily_weight_trend: [],
            purchase_spend_trend: [],
            avg_price_per_kg_trend: [],

            total_processing_orders: 0,
            total_input_qty: 0,
            wip_stock_kg: 0,
            wip_stock_by_product: [],
            active_blast_freeze_count: 0,
            processing_status_breakdown: [],
            input_qty_by_species: [],
            blast_freeze_status: [],
            recent_processing_table: [],

            qc_total: 0,
            qc_fail_count: 0,
            qc_todo_count: 0,
            qc_hold_count: 0,
            iqc_total: 0,
            iqc_pass_rate: 0,
            ipqc_total: 0,
            ipqc_pass_rate: 0,
            final_qc_total: 0,
            final_qc_pass_rate: 0,
            ipqc_by_operation_chart: { labels: [], pass: [], fail: [] },
            avg_histamine_ppm: 0,
            avg_sensory_score: 0,
            qc_stage_breakdown: [],
            intake_decision_breakdown: [],
            residue_screening: { labels: [], antibiotic: [], sulphite: [] },
            qc_trend: [],
            rejected_qty_by_species: [],
            recent_qc_table: [],

            budget_id: false,
            budget_name: '',
            budget_state: '',
            budget_period_from: false,
            budget_period_to: false,
            budget_total_planned: 0,
            budget_total_practical: 0,
            budget_total_theoretical: 0,
            budget_total_gross_margin: 0,
            budget_achievement_pct: 0,
            budget_lines_table: [],
            budget_chart: [],

            drill: {
                isOpen: false,
                title: '',
                model: false,
                records: [],
                columns: [],
                loading: false,
            },
        });
        onMounted(() => this.loadData());
        onMounted(() => this._loadWeather());
        onMounted(() => this._initCountUpObserver());
        onWillUnmount(() => this._teardownCountUpObserver());

        // ---- Tab bar glider (blue sliding highlight behind active tab) ----
        this.tabbarRef = useRef("tabbar");
        this.searchInputRef = useRef("searchInput");
        onMounted(() => this._updateTabGlider());
        // Re-measure after every render, not just tab switches: a resize,
        // sidebar collapse, or the tab labels reflowing can all move the
        // buttons without going through setActiveTab().
        onPatched(() => this._updateTabGlider());
        useExternalListener(window, "resize", () => this._updateTabGlider());

        // ---- Liquid ripple (stirs real content wherever the cursor moves) ----
        // See _initLiquidLens() below for the full explanation. Torn down
        // on unmount so the rAF loop / snapshot timer / listeners don't
        // keep running once the user navigates away from the dashboard.
        this.liquidLensRef = useRef("liquidLens");
        this.liquidLensCanvasRef = useRef("liquidLensCanvas");
        onMounted(() => this._initLiquidLens());
        onWillUnmount(() => this._teardownLiquidLens());
    }

    // Measures the currently-active tab button and positions the glider
    // under it. Runs off the real DOM because tab widths vary with their
    // label ("Overview" vs "Quality Control"), so a fixed percentage
    // transform (fine for 3 equal-width options) won't line up here.
    _updateTabGlider() {
        const bar = this.tabbarRef.el;
        if (!bar) return;
        const activeBtn = bar.querySelector(".tab.active");
        if (!activeBtn) return;
        const barRect = bar.getBoundingClientRect();
        const btnRect = activeBtn.getBoundingClientRect();
        const left = btnRect.left - barRect.left;
        const width = btnRect.width;
        if (left !== this.ui.tabGlider.left || width !== this.ui.tabGlider.width || !this.ui.tabGlider.ready) {
            this.ui.tabGlider.left = left;
            this.ui.tabGlider.width = width;
            this.ui.tabGlider.ready = true;
        }
    }

    // ---- Shared UI helper: status label -> badge color class ----
    badgeClass(label) {
        const GREEN = ['Completed', 'Done', 'Passed', 'Pass', 'Accept', 'Delivered'];
        const RED = ['Cancelled', 'Failed', 'Fail', 'Reject', 'Detected'];
        const AMBER = ['Open', 'Waiting', 'Draft', 'To Do', 'Downgrade / Conditional', 'Pending'];
        const BLUE = ['Confirmed', 'In Progress', 'Ready', 'Booked', 'Stuffed', 'Scheduled', 'Running'];
        if (GREEN.includes(label)) return 'aqua-badge--green';
        if (RED.includes(label)) return 'aqua-badge--red';
        if (AMBER.includes(label)) return 'aqua-badge--amber';
        if (BLUE.includes(label)) return 'aqua-badge--blue';
        return 'aqua-badge--gray';
    }

    // ---- Overview tab: hero photo expand/lightbox ----
    onHeroExpandClick() {
        this.ui.heroExpanded = true;
    }

    onHeroLightboxClose() {
        this.ui.heroExpanded = false;
    }

    // ---- Weather card (Overview) ----
    // Fallback coordinates (Visakhapatnam) used only if the browser can't
    // or won't provide a real location - geolocation permission denied,
    // unsupported browser, no HTTPS context, etc. - so the card still
    // shows *something* rather than an error.
    static FALLBACK_LAT = 17.6868;
    static FALLBACK_LON = 83.2185;
    static FALLBACK_LOCATION_LABEL = 'Visakhapatnam, India';
    // localStorage key for the dark mode toggle (avatar popover) - see
    // onToggleDarkMode() and the ui.darkMode restore in setup() above.
    static DARK_MODE_STORAGE_KEY = 'aqua_food_processing.dark_mode';
    // Class toggled on document.body (not this.el) so the themed
    // scrollbar CSS in dashboard.css can reach the page's native
    // scrollbar - see _syncBodyDarkScrollbar() below.
    static DARK_SCROLLBAR_BODY_CLASS = 'o_aqua_dashboard_dark_scrollbar';

    // Resolves the browser's current position via the Geolocation API,
    // wrapped in a promise with a timeout so a slow/never-answered
    // permission prompt doesn't hang the weather card forever.
    _getBrowserLocation() {
        return new Promise((resolve) => {
            if (!('geolocation' in navigator)) {
                resolve(null);
                return;
            }
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
                () => resolve(null),
                { timeout: 8000, maximumAge: 10 * 60 * 1000 }
            );
        });
    }

    // Lat/lon -> "City, Country" via BigDataCloud's free, keyless reverse-
    // geocoding endpoint (client-side, no account/API key needed). Falls
    // back to a bare coordinate string if the lookup itself fails, so the
    // weather numbers still display even without a nice place name.
    async _reverseGeocode(lat, lon) {
        try {
            const resp = await fetch(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const city = data.city || data.locality || data.principalSubdivision || '';
            const country = data.countryName || '';
            return [city, country].filter(Boolean).join(', ') || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
        } catch (e) {
            return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
        }
    }

    // Open-Meteo needs no API key and allows browser-side CORS requests,
    // so this is fetched straight from the client rather than proxied
    // through an Odoo controller. Location: tries the browser's actual
    // position first (this dashboard can be opened from anywhere, not
    // just from inside the plant), and only falls back to the fixed
    // Visakhapatnam coordinates if geolocation is denied/unavailable.
    async _loadWeather() {
        this.weather.loading = true;
        this.weather.error = false;
        try {
            const browserLoc = await this._getBrowserLocation();
            const lat = browserLoc ? browserLoc.lat : AquaDashboard.FALLBACK_LAT;
            const lon = browserLoc ? browserLoc.lon : AquaDashboard.FALLBACK_LON;

            this.weather.locationLabel = browserLoc
                ? await this._reverseGeocode(lat, lon)
                : AquaDashboard.FALLBACK_LOCATION_LABEL;

            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day&timezone=auto`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const c = data.current || {};
            this.weather.tempC = c.temperature_2m ?? null;
            this.weather.humidity = c.relative_humidity_2m ?? null;
            this.weather.windKph = c.wind_speed_10m ?? null;
            this.weather.code = c.weather_code ?? null;
            this.weather.isDay = c.is_day !== 0;
            this.weather.updatedAt = c.time
                ? new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';
        } catch (e) {
            this.weather.error = true;
        } finally {
            this.weather.loading = false;
        }
    }

    // WMO weather codes (used by Open-Meteo) collapsed down to the handful
    // of icon/label buckets this card actually draws.
    get weatherConditionLabel() {
        const code = this.weather.code;
        if (code === null || code === undefined) return '';
        if (code === 0) return this.weather.isDay ? 'Clear sky' : 'Clear night';
        if ([1, 2].includes(code)) return 'Partly cloudy';
        if (code === 3) return 'Cloudy';
        if ([45, 48].includes(code)) return 'Foggy';
        if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
        if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
        if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
        if ([95, 96, 99].includes(code)) return 'Thunderstorm';
        return 'Partly cloudy';
    }

    get weatherIconKey() {
        const code = this.weather.code;
        if (code === null || code === undefined) return 'partly_cloudy';
        if (code === 0) return this.weather.isDay ? 'sunny' : 'clear_night';
        if ([1, 2].includes(code)) return 'partly_cloudy';
        if (code === 3) return 'cloudy';
        if ([45, 48].includes(code)) return 'fog';
        if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
        if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
        if ([95, 96, 99].includes(code)) return 'storm';
        return 'partly_cloudy';
    }

    // Plain-number display getters: QWeb resolves a bare `Math`/`Number`
    // in a template expression as a lookup on the render context (and
    // throws), so rounding happens here instead of inline in the XML.
    get weatherTempDisplay() { return this.weather.tempC === null ? '--' : Math.round(this.weather.tempC); }
    get weatherHumidityDisplay() { return this.weather.humidity === null ? '--' : Math.round(this.weather.humidity); }
    get weatherWindDisplay() { return this.weather.windKph === null ? '--' : Math.round(this.weather.windKph); }

    // ---- Topbar quick search ----
    // Collapsed to a plain icon-button (same look as the bell/export
    // icons) until clicked; expands into the input, focuses it, and
    // collapses itself back down once it loses focus with nothing typed.
    onSearchWrapClick() {
        if (this.ui.searchExpanded) return;
        this.ui.searchExpanded = true;
        requestAnimationFrame(() => {
            if (this.searchInputRef.el) this.searchInputRef.el.focus();
        });
    }

    // Debounced so a fast typist doesn't fire one RPC per keystroke; 250ms
    // is short enough that the dropdown still feels instant.
    onSearchInput(ev) {
        this.search.query = ev.target.value;
        clearTimeout(this._searchDebounce);
        const q = this.search.query.trim();
        if (q.length < 2) {
            this.search.results = [];
            this.search.isOpen = false;
            return;
        }
        this._searchDebounce = setTimeout(() => this._runSearch(q), 250);
    }

    async _runSearch(query) {
        this.search.loading = true;
        this.search.isOpen = true;
        try {
            const results = await this.orm.call("aqua.dashboard", "global_search", [query]);
            // The query can change while the RPC is in flight; drop a stale response.
            if (this.search.query.trim() === query) {
                this.search.results = results || [];
            }
        } catch (e) {
            this.search.results = [];
        } finally {
            this.search.loading = false;
        }
    }

    onSearchFocus() {
        if (this.search.results.length) this.search.isOpen = true;
    }

    // Results grouped by record type for the dropdown - computed here
    // rather than in the template so the "one heading per group" logic
    // doesn't depend on QWeb's per-iteration variable scoping.
    get searchGroups() {
        const groups = [];
        const byGroup = {};
        for (const r of this.search.results) {
            if (!byGroup[r.group]) {
                byGroup[r.group] = { group: r.group, items: [] };
                groups.push(byGroup[r.group]);
            }
            byGroup[r.group].items.push(r);
        }
        return groups;
    }

    // Delay the close slightly so the click on a result row lands before
    // the dropdown unmounts underneath it.
    onSearchBlur() {
        setTimeout(() => {
            this.search.isOpen = false;
            if (!this.search.query) this.ui.searchExpanded = false;
        }, 150);
    }

    onSearchClear() {
        this.search.query = '';
        this.search.results = [];
        this.search.isOpen = false;
    }

    onSearchResultClick(result) {
        this.search.isOpen = false;
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: result.model,
            res_id: result.id,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    // ---- Tabs: Overview / Procurement / Processing / Quality Control ----
    setActiveTab(tabName) {
        this.state.activeTab = tabName;
    }

    isTabActive(tabName) {
        return this.state.activeTab === tabName;
    }

    get tabTitle() {
        const T = {
            overview: 'Aqua processing overview', procurement: 'Procurement',
            processing: 'Processing', quality: 'Quality control', budget: 'Budget',
        };
        return T[this.state.activeTab] || 'Aqua processing overview';
    }

    get tabSubtitle() {
        const T = {
            overview: 'Shrimp processing and export operations',
            procurement: 'Purchase → receiving → storage flow',
            processing: 'Intake → work-in-progress → cold storage',
            quality: 'IQC · IPQC · Final QC — full inspection lifecycle',
            budget: 'Planned vs actual, by cost center',
        };
        return T[this.state.activeTab] || '';
    }

    // ---- Filter bar: period + comparison (no branch/company -- single plant) ----
    onFilterChange(filters) {
        this.filters = filters;
        this.loadData();
    }

    onRefresh() {
        this.loadData();
    }

    // ---- Topbar: avatar popover ----
    // Clicking the avatar itself just opens a small popover (name + a "My
    // Profile" row) instead of jumping straight into the edit form - see
    // onProfileMenuClick() below for what that row does.
    onProfileButtonClick() {
        this.ui.profileOpen = !this.ui.profileOpen;
    }

    // Dark mode switch, in the same avatar popover as "My Profile". Flips
    // ui.darkMode (which the template maps onto an `o_aqua_dashboard--dark`
    // modifier class on the dashboard root - see dashboard_templates.xml
    // and the corresponding overrides in dashboard.css), and persists the
    // choice so it's remembered next time this user opens the dashboard.
    // Kept as its own row rather than closing the popover on click, since
    // someone flipping the switch a couple of times to compare light/dark
    // shouldn't have to reopen the menu each time.
    onToggleDarkMode() {
        this.ui.darkMode = !this.ui.darkMode;
        this._syncBodyDarkScrollbar();
        try {
            window.localStorage.setItem(
                AquaDashboard.DARK_MODE_STORAGE_KEY,
                this.ui.darkMode ? '1' : '0'
            );
        } catch (e) {
            // Preference just won't persist across reloads - not worth
            // failing the toggle itself over.
        }
    }

    // See the DARK_SCROLLBAR_BODY_CLASS comment above - keeps <body>'s
    // class in step with ui.darkMode so the page's native scrollbar (and
    // the drill panel's/any inner table-scroll's) picks up the themed
    // thumb/track from dashboard.css.
    _syncBodyDarkScrollbar() {
        document.body.classList.toggle(AquaDashboard.DARK_SCROLLBAR_BODY_CLASS, this.ui.darkMode);
    }

    // Opens the same res.users form the standard Odoo user-menu avatar
    // (top-right, above this dashboard) opens under "My Profile" - this is
    // a convenience shortcut for people who live inside this dashboard all
    // day, not a replacement for that menu.
    onProfileMenuClick() {
        this.ui.profileOpen = false;
        this.action.doAction({
            type: 'ir.actions.act_window',
            name: 'My Profile',
            res_model: 'res.users',
            res_id: this.user.userId,
            views: [[false, 'form']],
            target: 'new',
            // Same fields as the stock "My Profile" quick-edit, just under
            // our own view id (aqua_profile_form_view) so the dialog
            // carries a class the dashboard CSS can hook into - see
            // views/dashboard/aqua_profile_form_views.xml.
            context: { form_view_ref: 'aqua_food_processing.aqua_profile_form_view' },
        });
    }

    // ---- Topbar: Export ----
    // Exports whichever tab is currently active as a CSV - one section per
    // card on that tab, in the same order they appear on screen. Kept
    // simple (label/value rows) rather than trying to reproduce every
    // chart's exact table shape; the drill-down panel's own "↓ CSV"
    // button already covers "export this one chart's underlying records"
    // in full detail.
    get _exportSections() {
        const tab = this.state.activeTab;

        if (tab === 'overview') {
            return [
                { title: 'Overview KPIs', headers: ['Metric', 'Value'], rows: [
                    ['Raw material received (kg)', this.state.total_weight_received],
                    ['In production (kg)', this.state.total_input_qty],
                    ['Finished goods (kg)', this.state.total_stock_on_hand],
                    ['Yield (period) %', this.ovYieldPct],
                ] },
                { title: 'Resource monitoring', headers: ['Category', 'Value (kg)'],
                  rows: this.ovResourceMonitoringParts.map((p) => [p.label, p.value]) },
            ];
        }

        if (tab === 'procurement') {
            return [
                { title: 'Receipt status', headers: ['Status', 'Count'],
                  rows: this.ovReceiptStatusRows.map((r) => [r.label, r.value]) },
                { title: 'Receipts by species', headers: ['Species', 'Count'],
                  rows: this.procSpeciesRows.map((r) => [r.label, r.value]) },
                { title: 'Spend by vendor', headers: ['Vendor', 'Spend'],
                  rows: this.procSpendByVendorRows.map((r) => [r.label, r.value]) },
                { title: 'Received weight by vendor (kg)', headers: ['Vendor', 'Weight (kg)'],
                  rows: this.procWeightByVendorRows.map((r) => [r.label, r.value]) },
                { title: 'Ordered vs received', headers: ['Receipt', 'Ordered (kg)', 'Received (kg)'],
                  rows: this.procOrderedVsReceivedRows.map((r) => [r.label, r.ordered, r.received]) },
                { title: 'Current stock by product', headers: ['Product', 'Qty (kg)'],
                  rows: this.procStockByProductRows.map((r) => [r.label, r.value]) },
                { title: 'Current stock by location', headers: ['Location', 'Qty (kg)'],
                  rows: this.procStockByLocationRows.map((r) => [r.label, r.value]) },
            ];
        }

        if (tab === 'processing') {
            return [
                { title: 'Processing order status', headers: ['Status', 'Count'],
                  rows: (this.state.processing_status_breakdown || []).map((r) => [r.label, r.value]) },
                { title: 'Input weight by species', headers: ['Species', 'Weight (kg)'],
                  rows: this.procgInputSpeciesRows.map((r) => [r.label, r.value]) },
                { title: 'Blast freeze status', headers: ['Status', 'Count'],
                  rows: (this.state.blast_freeze_status || []).map((r) => [r.label, r.value]) },
                { title: 'WIP stock by product', headers: ['Product', 'Qty (kg)'],
                  rows: (this.state.wip_stock_by_product || []).map((r) => [r.label, r.value]) },
            ];
        }

        if (tab === 'quality') {
            return [
                { title: 'Checks by stage', headers: ['Stage', 'Count'],
                  rows: this.qQcStageRows.map((r) => [r.label, r.value]) },
                { title: 'Intake decisions', headers: ['Decision', 'Count'],
                  rows: this.qIntakeDecisionRows.map((r) => [r.label, r.value]) },
                { title: 'IPQC by shop-floor operation', headers: ['Operation', 'Pass', 'Fail'],
                  rows: this.qIpqcByOperationRows.map((r) => [r.label, r.pass, r.fail]) },
                { title: 'Rejected quantity by species', headers: ['Species', 'Qty (kg)'],
                  rows: (this.state.rejected_qty_by_species || []).map((r) => [r.label, r.value]) },
            ];
        }

        if (tab === 'budget') {
            return [
                { title: 'Budget summary', headers: ['Metric', 'Value'], rows: [
                    ['Total planned', this.state.budget_total_planned],
                    ['Actual (practical)', this.state.budget_total_practical],
                    ['Theoretical (to date)', this.state.budget_total_theoretical],
                    ['Gross margin', this.state.budget_total_gross_margin],
                    ['Achievement %', this.state.budget_achievement_pct],
                ] },
                { title: 'Planned vs practical by cost center', headers: ['Cost center', 'Planned', 'Practical'],
                  rows: this.budgetPairRows.map((r) => [r.label, r.planned, r.practical]) },
            ];
        }

        return [];
    }

    onExportDashboard() {
        this.ui.exportJustClicked = true;
        setTimeout(() => { this.ui.exportJustClicked = false; }, 600);
        const sections = this._exportSections.filter((s) => s.rows.length);
        if (!sections.length) {
            this.notification.add('Nothing to export on this tab yet.', { type: 'warning' });
            return;
        }
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [];
        for (const sec of sections) {
            lines.push(esc(sec.title));
            if (sec.headers) lines.push(sec.headers.map(esc).join(','));
            for (const row of sec.rows) lines.push(row.map(esc).join(','));
            lines.push('');
        }
        const csv = lines.join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aqua_dashboard_${this.state.activeTab}_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async loadData() {
        this.state.isLoading = true;
        this._dashboardIds = await this.orm.create("aqua.dashboard", [{}]);
        const data = await this.orm.call("aqua.dashboard", "get_dashboard_data", [this._dashboardIds], {
            period: this.filters.period,
            compare: this.filters.compare,
            date_from: this.filters.period === 'custom' ? this.filters.customFrom : false,
            date_to: this.filters.period === 'custom' ? this.filters.customTo : false,
        });
        Object.assign(this.state, data);
        this.state.isLoading = false;

        // Bell shake: only (re)trigger it when the actual set of alerts has
        // changed since it was last seen -- a plain refresh that turns up
        // the same alerts shouldn't restart an animation the user already
        // dismissed.
        const alertsSignature = `${this.state.qc_hold_count}|${this.state.qc_fail_count}|${this.state.cancelled_receipts}`;
        if (alertsSignature !== this.ui.alertsSignature) {
            this.ui.alertsSignature = alertsSignature;
            this.ui.alertsDismissed = !this.hasActiveAlerts;
        }
    }

    // ---- Topbar: notification bell ----
    get hasActiveAlerts() {
        return !!(this.state.qc_hold_count || this.state.qc_fail_count || this.state.cancelled_receipts);
    }

    get bellIsShaking() {
        return this.hasActiveAlerts && !this.ui.alertsDismissed;
    }

    onBellClick() {
        // Stops the shake immediately (don't wait on the network round-trip
        // below) and opens the popover listing the current alerts. Only
        // refreshes data when *opening* it, not on every toggle.
        this.ui.alertsDismissed = true;
        this.ui.notifOpen = !this.ui.notifOpen;
        if (this.ui.notifOpen) {
            this.onRefresh();
        }
    }

    // Wraps the existing onDrillXxx handlers so clicking a row inside the
    // notifications popover both opens the drill panel and closes the
    // popover, instead of leaving it open behind the drill panel.
    onBellAlertClick(handlerName) {
        this.ui.notifOpen = false;
        this[handlerName]();
    }

    // ---- KPI sparkline ----
    // Weekly receipt trend is the only series that naturally matches "total
    // receipts" - reused here rather than asking the backend for a separate
    // series just for a KPI tile decoration.
    get receiptsSparkline() {
        return this.state.receipt_trend.map((x) => x.value);
    }

    // Daily received-weight series, reused as the sparkline behind the
    // "Current Stock On Hand" KPI tile so it visually shows recent intake momentum.
    get stockSparkline() {
        return this.state.daily_weight_trend.map((x) => x.value);
    }

    // ---- Chart.js data getters, {label, value} lists -> {labels, datasets} ----

    get speciesChartData() {
        const rows = this.state.receipts_by_species;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Catch Receipts", data: rows.map((x) => x.value) }],
        };
    }

    get qcChartData() {
        const rows = this.state.qc_breakdown;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value) }],
        };
    }

    get shipmentChartData() {
        const rows = this.state.shipment_breakdown;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value) }],
        };
    }

    get receiptTrendChartData() {
        const rows = this.state.receipt_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Receipts", data: rows.map((x) => x.value), borderColor: "#2C7A7B" }],
        };
    }

    get coldRoomChartData() {
        const rows = this.state.cold_room_utilization;
        return {
            labels: rows.map((x) => x.name),
            datasets: [{ label: "Utilization %", data: rows.map((x) => x.pct), borderColor: "#3182CE" }],
        };
    }

    // ---- Procurement chart data getters ----

    get receiptStatusChartData() {
        const rows = this.state.receipt_status_breakdown;
        const COLORS = { Open: "#D69E2E", Completed: "#38A169", Cancelled: "#C53030" };
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value), backgroundColor: rows.map((x) => COLORS[x.label] || "#718096") }],
        };
    }

    get spendByVendorChartData() {
        const rows = this.state.spend_by_vendor;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Purchase Spend", data: rows.map((x) => x.value), backgroundColor: "#805AD5" }],
        };
    }

    get weightByVendorChartData() {
        const rows = this.state.weight_by_vendor;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Received (kg)", data: rows.map((x) => x.value), backgroundColor: "#2C7A7B" }],
        };
    }

    get orderedVsReceivedChartData() {
        const rows = this.state.ordered_vs_received;
        return {
            labels: rows.map((x) => x.label),
            datasets: [
                { label: "Ordered (kg)", data: rows.map((x) => x.ordered), backgroundColor: "#CBD5E0" },
                { label: "Received (kg)", data: rows.map((x) => x.received), backgroundColor: "#3182CE" },
            ],
        };
    }

    // ---- Live Inventory (current stock) chart data getters ----

    get currentStockByProductChartData() {
        const rows = this.state.current_stock_by_product;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "On Hand (kg)", data: rows.map((x) => x.value), backgroundColor: "#38A169" }],
        };
    }

    get currentStockByLocationChartData() {
        const rows = this.state.current_stock_by_location;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "On Hand (kg)", data: rows.map((x) => x.value), backgroundColor: "#3182CE" }],
        };
    }

    get purchaseToStockFunnelChartData() {
        const rows = this.state.purchase_to_stock_funnel;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{
                label: "kg",
                data: rows.map((x) => x.value),
                backgroundColor: ["#CBD5E0", "#3182CE", "#38A169"],
            }],
        };
    }

    get dailyWeightTrendChartData() {
        const rows = this.state.daily_weight_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Received (kg)", data: rows.map((x) => x.value), borderColor: "#2C7A7B" }],
        };
    }

    get receiptTrendTitle() {
        return `${this.state.trend_granularity_label} Receipt Trend`;
    }

    get qcTrendTitle() {
        return `${this.state.trend_granularity_label} QC Checks Trend`;
    }

    get weightReceivedTrendTitle() {
        return `Weight Received Trend (${this.state.trend_granularity_label}, kg)`;
    }

    get purchaseSpendTrendTitle() {
        return `Purchase Spend Trend (${this.state.trend_granularity_label}, ₹)`;
    }

    get avgPriceTrendTitle() {
        return `Avg Price / kg Trend (${this.state.trend_granularity_label}, ₹)`;
    }

    get purchaseSpendTrendChartData() {
        const rows = this.state.purchase_spend_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Spend", data: rows.map((x) => x.value), borderColor: "#805AD5" }],
        };
    }

    get avgPriceTrendChartData() {
        const rows = this.state.avg_price_per_kg_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Avg Price / kg", data: rows.map((x) => x.value), borderColor: "#D69E2E" }],
        };
    }

    // ---- Processing chart data getters ----

    get processingStatusChartData() {
        const rows = this.state.processing_status_breakdown;
        const COLORS = { Draft: "#CBD5E0", Confirmed: "#D69E2E", "In Progress": "#3182CE", "To Close": "#805AD5", Done: "#38A169", Cancelled: "#C53030" };
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value), backgroundColor: rows.map((x) => COLORS[x.label] || "#718096") }],
        };
    }

    get inputQtyBySpeciesChartData() {
        const rows = this.state.input_qty_by_species;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Input (kg)", data: rows.map((x) => x.value), backgroundColor: "#2C7A7B" }],
        };
    }

    get wipStockByProductChartData() {
        const rows = this.state.wip_stock_by_product;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Staged for Processing (kg)", data: rows.map((x) => x.value), backgroundColor: "#805AD5" }],
        };
    }

    get blastFreezeChartData() {
        const rows = this.state.blast_freeze_status;
        const COLORS = { Scheduled: "#CBD5E0", Running: "#3182CE", Completed: "#38A169" };
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value), backgroundColor: rows.map((x) => COLORS[x.label] || "#718096") }],
        };
    }

    // ---- Quality Control chart data getters ----

    get qcStageChartData() {
        const rows = this.state.qc_stage_breakdown;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value), backgroundColor: ["#3182CE", "#805AD5", "#38A169"] }],
        };
    }

    get ipqcByOperationChartData() {
        const r = this.state.ipqc_by_operation_chart;
        return {
            labels: r.labels,
            datasets: [
                { label: "Pass", data: r.pass, backgroundColor: "#38A169" },
                { label: "Fail", data: r.fail, backgroundColor: "#C53030" },
            ],
        };
    }

    get intakeDecisionChartData() {
        const rows = this.state.intake_decision_breakdown;
        const COLORS = { Accept: "#38A169", Reject: "#C53030", "Downgrade / Conditional": "#D69E2E" };
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ data: rows.map((x) => x.value), backgroundColor: rows.map((x) => COLORS[x.label] || "#718096") }],
        };
    }

    get residueScreeningChartData() {
        const r = this.state.residue_screening;
        return {
            labels: r.labels,
            datasets: [
                { label: "Antibiotic Residue", data: r.antibiotic, backgroundColor: "#805AD5" },
                { label: "Sulphite / Preservative", data: r.sulphite, backgroundColor: "#3182CE" },
            ],
        };
    }

    get qcTrendChartData() {
        const rows = this.state.qc_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "QC Checks", data: rows.map((x) => x.value), borderColor: "#38A169" }],
        };
    }

    get rejectedQtyBySpeciesChartData() {
        const rows = this.state.rejected_qty_by_species;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Rejected (kg)", data: rows.map((x) => x.value), backgroundColor: "#C53030" }],
        };
    }

    // ---- Budget tab: Planned vs Practical (Actual), one bar pair per cost center ----
    get budgetChartData() {
        const rows = this.state.budget_chart;
        return {
            labels: rows.map((x) => x.label),
            datasets: [
                { label: "Planned", data: rows.map((x) => x.planned), backgroundColor: "#3182CE" },
                { label: "Practical (Actual)", data: rows.map((x) => x.practical), backgroundColor: "#38A169" },
            ],
        };
    }

    onOpenBudgetRecord() {
        if (!this.state.budget_id) return;
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'budget.budget',
            res_id: this.state.budget_id,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    // budget.budget's state field uses technical values ('draft', 'confirmed',
    // 'validate', 'done', 'cancel') -- map to the same labels shown on the
    // record's own status bar (e.g. 'validate' -> 'Validated') instead of
    // printing the raw value on the dashboard's status pill.
    get budgetStateLabel() {
        const LABELS = {
            draft: 'Draft', confirmed: 'Confirmed', validate: 'Validated',
            done: 'Done', cancel: 'Cancelled',
        };
        const key = (this.state.budget_state || '').toLowerCase();
        return LABELS[key] || this.state.budget_state || 'Draft';
    }

    // ==================================================================
    //  Visual-system helpers for the new mockup-accurate templates:
    //  number/currency formatting + SVG geometry for gauges, donuts and
    //  trend lines. Pure functions of state - no data fetching here.
    // ==================================================================

    static COLORS = {
        blue: '#2F6FED', teal: '#12A594', amber: '#E8940C',
        coral: '#E2543A', purple: '#7C6CF0', green: '#3AA655', gray: '#CBD5E0',
    };

    // ==================================================================
    //  KPI count-up animation
    // ------------------------------------------------------------------
    //  Any element rendered with data-countup="<raw number>" and
    //  data-count-fmt="<name of a formatter method on this class>" (see
    //  the .stat-val / .val elements in dashboard_templates.xml) gets
    //  animated from its last known value up/down to the new one whenever
    //  that attribute changes - including the very first time it appears,
    //  e.g. a tab switch mounting a fresh KPI grid, so it counts up from 0
    //  instead of just popping the final number into place.
    //
    //  Implemented with a MutationObserver instead of an Owl lifecycle
    //  hook so it doesn't care *why* the DOM changed (initial render, tab
    //  switch remounting a whole subtree, a filter reload patching a
    //  single number) - anything with that attribute gets the same
    //  treatment automatically, wherever it's used.
    // ==================================================================
    _initCountUpObserver() {
        this._countUpLastValues = new WeakMap();
        this._countUpFrames = new WeakMap();
        // Same draw-in treatment as the KPI count-up above, but for the
        // SVG donut/ring arcs (see data-donut-arc on the segment <circle>
        // elements in dashboard_templates.xml): each arc grows from an
        // empty ring up to its final sweep length instead of just
        // appearing fully drawn, on initial load, tab switches and any
        // filter/period change that recomputes the segments.
        this._donutArcLastValues = new WeakMap();
        this._donutArcFrames = new WeakMap();
        // Same idea again, but for the plain rectangular bar fills used
        // all over the dashboard: horizontal progress/track bars, the
        // purchase-to-stock funnel, WIP bars, stacked pass/fail segments,
        // etc. (data-bar-pct, animates CSS width) and the vertical
        // "ordered vs received" column sticks (data-bar-pct-v, animates
        // CSS height). Each bar grows from 0 up to its target percentage
        // instead of just appearing at full length.
        this._barPctLastValues = new WeakMap();
        this._barPctFrames = new WeakMap();
        this._barPctVLastValues = new WeakMap();
        this._barPctVFrames = new WeakMap();
        const root = document.querySelector(".o_aqua_dashboard");
        if (!root) return;
        this._countUpRoot = root;

        const scan = (el) => {
            if (!el.querySelectorAll) return;
            const countupNodes = el.matches && el.matches("[data-countup]")
                ? [el, ...el.querySelectorAll("[data-countup]")]
                : el.querySelectorAll("[data-countup]");
            countupNodes.forEach((node) => this._runCountUp(node));

            const donutNodes = el.matches && el.matches("[data-donut-arc]")
                ? [el, ...el.querySelectorAll("[data-donut-arc]")]
                : el.querySelectorAll("[data-donut-arc]");
            donutNodes.forEach((node) => this._runDonutArc(node));

            const barNodes = el.matches && el.matches("[data-bar-pct]")
                ? [el, ...el.querySelectorAll("[data-bar-pct]")]
                : el.querySelectorAll("[data-bar-pct]");
            barNodes.forEach((node) => this._runBarPct(node, "h"));

            const barVNodes = el.matches && el.matches("[data-bar-pct-v]")
                ? [el, ...el.querySelectorAll("[data-bar-pct-v]")]
                : el.querySelectorAll("[data-bar-pct-v]");
            barVNodes.forEach((node) => this._runBarPct(node, "v"));
        };

        this._countUpObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === "attributes" && m.target.hasAttribute("data-countup")) {
                    this._runCountUp(m.target);
                } else if (m.type === "attributes" && m.target.hasAttribute("data-donut-arc")) {
                    this._runDonutArc(m.target);
                } else if (m.type === "attributes" && m.target.hasAttribute("data-bar-pct")) {
                    this._runBarPct(m.target, "h");
                } else if (m.type === "attributes" && m.target.hasAttribute("data-bar-pct-v")) {
                    this._runBarPct(m.target, "v");
                } else if (m.type === "childList") {
                    m.addedNodes.forEach((n) => {
                        if (n.nodeType === 1) scan(n);
                    });
                }
            }
        });
        this._countUpObserver.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-countup", "data-donut-arc", "data-bar-pct", "data-bar-pct-v"],
        });

        // Anything already in the DOM on first mount (initial page load)
        // counts up / draws in from empty too, same as a freshly-mounted tab.
        scan(root);
    }

    _teardownCountUpObserver() {
        if (this._countUpObserver) {
            this._countUpObserver.disconnect();
            this._countUpObserver = null;
        }
        (this._countUpFrames instanceof WeakMap) && null; // no-op, WeakMap needs no explicit cleanup
    }

    _runCountUp(el) {
        const raw = el.getAttribute("data-countup");
        if (raw === null) return;
        const target = Number(raw);
        if (Number.isNaN(target)) return;

        const fmtName = el.getAttribute("data-count-fmt") || "fmtNum";
        const suffix = el.getAttribute("data-count-suffix") || "";
        const fmtFn = typeof this[fmtName] === "function" ? this[fmtName].bind(this) : (v) => String(Math.round(v));

        const from = this._countUpLastValues.get(el);
        const start = from === undefined ? 0 : from;
        // Nothing meaningfully changed (e.g. an unrelated re-render touched
        // the attribute but wrote the same number) - skip re-animating.
        if (from !== undefined && Math.abs(from - target) < 0.005) return;

        const prevFrame = this._countUpFrames.get(el);
        if (prevFrame) cancelAnimationFrame(prevFrame);

        const duration = 700;
        const t0 = performance.now();
        const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

        const step = (now) => {
            const elapsed = now - t0;
            const p = Math.min(1, elapsed / duration);
            const eased = easeOutQuart(p);
            const current = start + (target - start) * eased;
            el.textContent = fmtFn(current) + suffix;
            if (p < 1) {
                this._countUpFrames.set(el, requestAnimationFrame(step));
            } else {
                el.textContent = fmtFn(target) + suffix;
                this._countUpLastValues.set(el, target);
                this._countUpFrames.delete(el);
            }
        };
        this._countUpFrames.set(el, requestAnimationFrame(step));
    }

    // ==================================================================
    //  Donut/ring arc draw-in animation
    // ------------------------------------------------------------------
    //  Companion to the KPI count-up above, for the SVG segment <circle>
    //  elements used by every donut chart on the dashboard (Resource
    //  monitoring, Receipt status, Processing order status, Blast freeze
    //  status, Checks by stage, Intake decisions - see donutSegments()
    //  below and the matching data-donut-arc bindings in
    //  dashboard_templates.xml). Each element carries
    //  data-donut-arc="<len> <circumference>" (the same numbers used for
    //  the real stroke-dasharray); whenever that attribute appears or
    //  changes - initial mount, a tab switch remounting the chart, or a
    //  filter/period change recomputing the segments - the arc's visible
    //  length is animated from its last known value (0 the first time) up
    //  to the new one, instead of the ring just popping into its final
    //  shape. stroke-dashoffset is left alone: only the drawn length of
    //  the arc grows, so it sweeps out in place from the same start point.
    // ==================================================================
    _runDonutArc(el) {
        const raw = el.getAttribute("data-donut-arc");
        if (raw === null) return;
        const nums = raw.trim().split(/\s+/).map(Number);
        const target = nums[0];
        const circ = nums[1];
        if (Number.isNaN(target) || Number.isNaN(circ)) return;

        const from = this._donutArcLastValues.get(el);
        const start = from === undefined ? 0 : from;
        // Nothing meaningfully changed - skip re-animating, just make sure
        // the live attribute matches (in case circ itself shifted slightly).
        if (from !== undefined && Math.abs(from - target) < 0.05) {
            el.setAttribute("stroke-dasharray", `${target.toFixed(1)} ${circ.toFixed(1)}`);
            this._donutArcLastValues.set(el, target);
            return;
        }

        const prevFrame = this._donutArcFrames.get(el);
        if (prevFrame) cancelAnimationFrame(prevFrame);

        const duration = 800;
        const t0 = performance.now();
        const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

        const step = (now) => {
            const elapsed = now - t0;
            const p = Math.min(1, elapsed / duration);
            const eased = easeOutQuart(p);
            const current = start + (target - start) * eased;
            el.setAttribute("stroke-dasharray", `${current.toFixed(1)} ${circ.toFixed(1)}`);
            if (p < 1) {
                this._donutArcFrames.set(el, requestAnimationFrame(step));
            } else {
                el.setAttribute("stroke-dasharray", `${target.toFixed(1)} ${circ.toFixed(1)}`);
                this._donutArcLastValues.set(el, target);
                this._donutArcFrames.delete(el);
            }
        };
        this._donutArcFrames.set(el, requestAnimationFrame(step));
    }

    // ==================================================================
    //  Rectangular bar-fill draw-in animation
    // ------------------------------------------------------------------
    //  Covers every plain percentage bar on the dashboard: the .fill bars
    //  inside a .track (Production progress' operation breakdown,
    //  Receipts by species, Spend by vendor, Received weight by vendor,
    //  Today's stock by product/location, Input weight by species,
    //  Rejected qty by species, Planned vs practical by cost center...),
    //  the .funnel-bar in the Purchase-to-stock funnel, the .hbar-fill in
    //  the WIP-by-product chart, and the stacked .seg bars in IPQC by
    //  shop-floor operation / Residue screening - all of these carry
    //  data-bar-pct="<final %>" and animate their CSS width from 0 up to
    //  that percentage. The vertical column "sticks" in Ordered vs
    //  received carry data-bar-pct-v instead and animate height the same
    //  way. axis is "h" for width or "v" for height.
    // ==================================================================
    _runBarPct(el, axis) {
        const attr = axis === "v" ? "data-bar-pct-v" : "data-bar-pct";
        const prop = axis === "v" ? "height" : "width";
        const raw = el.getAttribute(attr);
        if (raw === null) return;
        const target = Number(raw);
        if (Number.isNaN(target)) return;

        const store = axis === "v" ? this._barPctVLastValues : this._barPctLastValues;
        const frames = axis === "v" ? this._barPctVFrames : this._barPctFrames;

        const from = store.get(el);
        const start = from === undefined ? 0 : from;
        if (from !== undefined && Math.abs(from - target) < 0.05) {
            el.style[prop] = `${target.toFixed(2)}%`;
            store.set(el, target);
            return;
        }

        const prevFrame = frames.get(el);
        if (prevFrame) cancelAnimationFrame(prevFrame);

        const duration = 800;
        const t0 = performance.now();
        const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);

        const step = (now) => {
            const elapsed = now - t0;
            const p = Math.min(1, elapsed / duration);
            const eased = easeOutQuart(p);
            const current = start + (target - start) * eased;
            el.style[prop] = `${current.toFixed(2)}%`;
            if (p < 1) {
                frames.set(el, requestAnimationFrame(step));
            } else {
                el.style[prop] = `${target.toFixed(2)}%`;
                store.set(el, target);
                frames.delete(el);
            }
        };
        frames.set(el, requestAnimationFrame(step));
    }

    fmtNum(v) {
        return Math.round(v || 0).toLocaleString('en-IN');
    }

    fmtPct(v) {
        return `${Number(v || 0).toFixed(1)}%`;
    }

    // Plain one-decimal number, no unit (template-safe: avoids referencing
    // the global Number() constructor directly inside a QWeb expression,
    // which OWL tries to resolve as ctx.Number and throws).
    fmt1(v) {
        return Number(v || 0).toFixed(1);
    }

    // kg -> compact Indian notation: "1.72L kg" / "3.4K kg" / "4.85Cr kg"
    // (kept the name fmtTon for compatibility with the templates; it now
    // formats in kilograms, not tons)
    fmtTon(kg) {
        return this._fmtKgCompact(kg);
    }

    // Same compact form, used inside the resource-monitoring donut center label.
    fmtTonCompact(kg) {
        return this._fmtKgCompact(kg);
    }

    _fmtKgCompact(kg) {
        kg = kg || 0;
        const abs = Math.abs(kg);
        if (abs >= 1e7) return `${(kg / 1e7).toFixed(2)}Cr kg`;
        if (abs >= 1e5) return `${(kg / 1e5).toFixed(2)}L kg`;
        if (abs >= 1e3) return `${(kg / 1e3).toFixed(2)}K kg`;
        return `${Math.round(kg).toLocaleString('en-IN')} kg`;
    }

    // ₹ -> Indian compact notation: ₹4.85 Cr / ₹86.4L / ₹12.3K
    fmtINR(v) {
        v = v || 0;
        const abs = Math.abs(v);
        if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
        if (abs >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
        if (abs >= 1e3) return `₹${(v / 1e3).toFixed(1)}K`;
        return `₹${Math.round(v)}`;
    }

    fmtINRPerKg(v) {
        return `₹${Math.round(v || 0)}/kg`;
    }

    // Half-circle gauge <path>, total length = π·r. Returns "filled total" for stroke-dasharray.
    semiArcDash(pct, r = 95) {
        const circ = Math.PI * r;
        const filled = Math.max(0, Math.min(100, pct || 0)) / 100 * circ;
        return `${filled.toFixed(1)} ${circ.toFixed(1)}`;
    }

    // Full-circle single-value gauge <circle>, total length = 2π·r.
    fullArcDash(pct, r = 52) {
        const circ = 2 * Math.PI * r;
        const filled = Math.max(0, Math.min(100, pct || 0)) / 100 * circ;
        return `${filled.toFixed(1)} ${circ.toFixed(1)}`;
    }

    // Multi-segment donut: [{label, value, color}] -> same rows + dasharray/dashoffset.
    // Segments are drawn as separate rounded-cap arcs with a visible gap between
    // them (not one continuous ring) to match the reference design. Zero/negative
    // values are dropped entirely rather than drawn at 0 length — a 0-length dash
    // with a round linecap still paints a small solid dot, which would otherwise
    // show up as a stray fleck of color on the ring.
    donutSegments(parts, r = 58) {
        const circ = 2 * Math.PI * r;
        const clean = (parts || []).filter((p) => (p.value || 0) > 0);
        const total = clean.reduce((s, p) => s + p.value, 0) || 1;
        const gap = clean.length > 1 ? 10 : 0; // px of arc-length left empty between segments
        let offset = 0;
        return clean.map((p) => {
            const slot = (p.value / total) * circ;
            const len = Math.max(0, slot - gap);
            const seg = {
                label: p.label, value: p.value, color: p.color,
                dasharray: `${len.toFixed(1)} ${circ.toFixed(1)}`,
                dashoffset: (-(offset + gap / 2)).toFixed(1),
            };
            offset += slot;
            return seg;
        });
    }

    statusColor(label) {
        const C = AquaDashboard.COLORS;
        const MAP = {
            Completed: C.green, Done: C.green, Passed: C.green, Pass: C.green, Accept: C.green, Delivered: C.green,
            Cancelled: C.coral, Failed: C.coral, Fail: C.coral, Reject: C.coral, Detected: C.coral,
            Open: C.amber, Waiting: C.amber, Draft: C.amber, 'To Do': C.amber, 'Downgrade / Conditional': C.amber, Pending: C.amber, Hold: C.amber,
            Confirmed: C.amber, 'In Progress': C.blue, Ready: C.blue, Booked: C.blue, Stuffed: C.blue, Scheduled: C.amber, Running: C.blue,
        };
        return MAP[label] || C.gray;
    }

    // Cycles the mockup's fixed 5-color order (blue, teal, purple, amber, coral).
    cyclePalette(index) {
        const P = [AquaDashboard.COLORS.blue, AquaDashboard.COLORS.teal, AquaDashboard.COLORS.purple, AquaDashboard.COLORS.amber, AquaDashboard.COLORS.coral];
        return P[index % P.length];
    }

    withStatusColors(rows) {
        return (rows || []).map((r) => ({ ...r, color: this.statusColor(r.label) }));
    }

    withCyclePalette(rows) {
        return (rows || []).map((r, i) => ({ ...r, color: this.cyclePalette(i) }));
    }

    // Bar width % relative to the max value in the same list (min 2% so a
    // non-zero row is never visually invisible).
    barPct(value, rows, key = 'value') {
        const max = Math.max(...(rows || []).map((r) => r[key] || 0), 1);
        return Math.max(2, Math.round(((value || 0) / max) * 100));
    }

    // ---- Legend click -> series show/hide (hand-drawn paired-bar cards) ----
    // A series is visible unless explicitly set to `false`; this mirrors
    // Chart.js's own default: nothing hidden until the user clicks a legend
    // item, and clicking it again brings it back.
    isSeriesVisible(chartId, seriesKey) {
        const entry = this.seriesVisibility[chartId];
        return !entry || entry[seriesKey] !== false;
    }

    toggleSeries(chartId, seriesKey) {
        if (!this.seriesVisibility[chartId]) {
            this.seriesVisibility[chartId] = {};
        }
        const entry = this.seriesVisibility[chartId];
        entry[seriesKey] = this.isSeriesVisible(chartId, seriesKey) ? false : true;
    }

    // CSS class for a legend row itself, so the dimmed/struck-through state
    // reflects which series is currently hidden.
    seriesLegendClass(chartId, seriesKey) {
        return this.isSeriesVisible(chartId, seriesKey) ? '' : 'legend-off';
    }

    // Drops any row whose label has been toggled off via a donut legend
    // click, before the remainder is handed to donutSegments() - this is
    // what makes the ring visually rebalance across the remaining slices,
    // the same way Chart.js redraws a pie/doughnut when a legend item is
    // hidden. Always filter on the *label*, not array index: the ring and
    // its legend are rendered from separate lists in a couple of places,
    // so index-based keys would not line up between them.
    _visibleRows(chartId, rows) {
        return (rows || []).filter((r) => this.isSeriesVisible(chartId, r.label));
    }

    _axisLabel(v) {
        if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
        if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
        if (v >= 1000) return `${Math.round(v / 1000)}K`;
        return `${Math.round(v)}`;
    }

    // rows: [{label, value}] -> grid lines, smooth curve path, filled area and end
    // points for the mockup's SVG trend-line cards.
    //
    // Renders a smooth Catmull-Rom-to-Bezier curve through the points (built by
    // hand below) rather than an SVG <polyline>, which can only ever draw
    // straight segments between points no matter how the data looks - that's
    // what was producing a sharp, pointed peak instead of the soft continuous
    // wave used throughout the reference mockups.
    lineChartGeometry(rows, opts = {}) {
        const width = opts.width || 580, height = opts.height || 200;
        const padL = 44, padR = 20, padT = 25, padB = 34;
        const baseline = height - padB;
        const plotW = width - padL - padR;
        const plotH = baseline - padT;
        rows = rows || [];
        const values = rows.map((r) => r.value || 0);
        const maxV = Math.max(...values, 1) * 1.18;
        const n = rows.length;
        const stepX = n > 1 ? plotW / (n - 1) : 0;
        const points = rows.map((r, i) => {
            const x = padL + stepX * i;
            const y = baseline - (maxV ? (r.value || 0) / maxV : 0) * plotH;
            return { x: +x.toFixed(1), y: +y.toFixed(1), label: r.label, value: r.value };
        });
        const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
        // Smooth curve: a Catmull-Rom spline converted to cubic Bezier segments
        // (each pair of on-curve points gets two control points derived from
        // its neighbours), exactly what Chart.js does internally for a
        // `tension`-based line - reproduced here by hand since this chart is
        // plain SVG, not Chart.js. `smoothing` (0-1) mirrors Chart.js `tension`.
        const smoothPath = (pts) => {
            if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : '';
            const smoothing = 0.6;
            let d = `M${pts[0].x},${pts[0].y}`;
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i === 0 ? 0 : i - 1];
                const p1 = pts[i];
                const p2 = pts[i + 1];
                const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
                const cp1x = p1.x + (p2.x - p0.x) / 6 * smoothing * 2;
                const cp1y = p1.y + (p2.y - p0.y) / 6 * smoothing * 2;
                const cp2x = p2.x - (p3.x - p1.x) / 6 * smoothing * 2;
                const cp2y = p2.y - (p3.y - p1.y) / 6 * smoothing * 2;
                d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x},${p2.y}`;
            }
            return d;
        };
        const linePath = smoothPath(points);
        const areaPath = points.length
            ? `${linePath} L${points[points.length - 1].x},${baseline} L${points[0].x},${baseline} Z`
            : '';
        const gridLines = [0, 1, 2, 3].map((i) => {
            const y = padT + (plotH / 3) * i;
            const val = maxV * (1 - i / 3);
            return { y: +y.toFixed(1), label: this._axisLabel(val) };
        });
        return {
            width, height, baseline, padL, padR, points, polyline, linePath, areaPath, gridLines,
            first: points[0] || { x: padL, y: baseline },
            last: points[points.length - 1] || { x: width - padR, y: baseline },
        };
    }

    // ---- Overview tab: donut / gauge / KPI row data, sourced from the
    // same aggregates already loaded for the other tabs (period-scoped by
    // the FilterBar, not literally "today" - the mockup's "today" framing
    // maps onto the dashboard's selected period everywhere below). ----

    get ovQcRows() { return this.withStatusColors(this.state.qc_breakdown); }
    get ovShipmentRows() { return this.withStatusColors(this.state.shipment_breakdown); }
    get ovReceiptStatusRows() { return this.withStatusColors(this.state.receipt_status_breakdown); }
    get ovColdRoomOverallPct() {
        const rooms = this.state.cold_room_utilization;
        if (!rooms.length) return 0;
        const cap = rooms.reduce((s, r) => s + (r.capacity_kg || 0), 0) || 1;
        const used = rooms.reduce((s, r) => s + (r.capacity_kg || 0) * (r.pct || 0) / 100, 0);
        return Math.round((used / cap) * 1000) / 10;
    }
    get ovYieldPct() {
        if (!this.state.total_input_qty) return 0;
        return Math.round((this.state.total_stock_on_hand / this.state.total_input_qty) * 1000) / 10;
    }

    // Period-over-period comparison chip for a g-stats tile, backed by the
    // comparison_pct/comparison_label the backend already computes for the
    // FilterBar's "Compare to" option. Returns null (no chip rendered) when
    // no comparison basis is selected, or when this particular metric has no
    // meaningful "vs prior period" reading (e.g. a live snapshot).
    //   invertColor: true for metrics where a *decrease* is the good outcome
    //   (e.g. Rejection rate), so the tint still reads "green = good".
    comparisonChip(key, invertColor = false) {
        if (!this.state.comparison_label) return null;
        const pct = this.state.comparison_pct[key];
        if (pct === undefined || pct === null) return null;
        const C = AquaDashboard.COLORS;
        const flat = Math.abs(pct) < 0.05;
        const goingUp = pct > 0;
        const isGood = flat ? true : (invertColor ? !goingUp : goingUp);
        const arrow = flat ? '▬' : (goingUp ? '▲' : '▼');
        return {
            text: `${arrow} ${Math.abs(pct).toFixed(1)}%`,
            bg: isGood ? `${C.green}22` : `${C.coral}22`,
            color: isGood ? C.green : C.coral,
        };
    }

    // "Resource monitoring" donut: mass flow through the plant this period,
    // built from aggregates already loaded elsewhere on the dashboard
    // (no separate backend model for this breakdown).
    //   Raw material      -> catch weight received
    //   Production output -> weight fed into processing
    //   Frozen stock in   -> WIP / holding stock (still moving into cold storage)
    //   Frozen stock out  -> finished stock on hand (ready to ship out)
    //   Others / waste    -> weight lost to rejected receipts
    get ovResourceMonitoringParts() {
        const C = AquaDashboard.COLORS;
        const rawMaterial = this.state.total_weight_received || 0;
        const productionOutput = this.state.total_input_qty || 0;
        const frozenStockIn = this.state.wip_stock_kg || 0;
        const frozenStockOut = this.state.total_stock_on_hand || 0;
        const waste = rawMaterial * ((this.state.rejection_rate || 0) / 100);
        return [
            { label: 'Raw material', value: rawMaterial, color: C.blue },
            { label: 'Production output', value: productionOutput, color: C.teal },
            { label: 'Frozen stock in', value: frozenStockIn, color: C.purple },
            { label: 'Frozen stock out', value: frozenStockOut, color: C.amber },
            { label: 'Others / waste', value: waste, color: C.coral },
        ];
    }
    get ovResourceMonitoringSegments() { return this.donutSegments(this._visibleRows('resource_monitoring', this.ovResourceMonitoringParts)); }
    get ovResourceMonitoringTotal() {
        return this.ovResourceMonitoringParts.reduce((s, p) => s + (p.value || 0), 0);
    }

    // ---- Procurement tab: donut / bar-list rows built from state ----

    get procReceiptStatusSegments() { return this.donutSegments(this._visibleRows('receipt_status', this.withStatusColors(this.state.receipt_status_breakdown))); }
    get procSpeciesRows() { return this.withCyclePalette(this.state.receipts_by_species); }
    get procSpendByVendorRows() { return this.state.spend_by_vendor; }
    get procWeightByVendorRows() { return this.withCyclePalette(this.state.weight_by_vendor); }
    get procStockByProductRows() { return this.withCyclePalette(this.state.current_stock_by_product); }
    get procStockByLocationRows() { return this.withCyclePalette(this.state.current_stock_by_location); }
    get procWeightTrendGeom() { return this.lineChartGeometry(this.state.daily_weight_trend); }
    get procSpendTrendGeom() { return this.lineChartGeometry(this.state.purchase_spend_trend); }
    get procOrderedVsReceivedRows() {
        const rows = this.state.ordered_vs_received;
        const max = Math.max(...rows.map((r) => Math.max(r.ordered || 0, r.received || 0)), 1);
        return rows.map((r) => ({
            ...r,
            orderedPct: Math.max(2, Math.round(((r.ordered || 0) / max) * 100)),
            receivedPct: Math.max(2, Math.round(((r.received || 0) / max) * 100)),
        }));
    }

    // ---- Processing tab ----

    get procgStatusSegments() { return this.donutSegments(this._visibleRows('processing_status', this.withStatusColors(this.state.processing_status_breakdown))); }
    get procgBlastFreezeSegments() { return this.donutSegments(this._visibleRows('blast_freeze', this.withStatusColors(this.state.blast_freeze_status))); }
    get procgInputSpeciesRows() { return this.withCyclePalette(this.state.input_qty_by_species); }
    get procgWipRows() { return this.withCyclePalette(this.state.wip_stock_by_product); }
    get procgOrderedByStatus() {
        const rows = this.state.processing_status_breakdown;
        const find = (label) => (rows.find((r) => r.label === label) || {}).value || 0;
        return { confirmed: find('Confirmed'), inProgress: find('In Progress'), done: find('Done') };
    }

    // ---- Quality tab ----

    // Unfiltered rows (for the legend, which must keep listing a toggled-off
    // slice so it can be clicked again) vs the filtered ring itself.
    get qQcStageRows() { return this.withCyclePalette(this.state.qc_stage_breakdown); }
    get qQcStageSegments() { return this.donutSegments(this._visibleRows('qc_stage', this.qQcStageRows)); }
    get qIntakeDecisionRows() { return this.withStatusColors(this.state.intake_decision_breakdown); }
    get qIntakeDecisionSegments() { return this.donutSegments(this._visibleRows('intake_decision', this.qIntakeDecisionRows)); }
    get qRejectedBySpeciesRows() { return this.state.rejected_qty_by_species.map((r) => ({ ...r, color: AquaDashboard.COLORS.coral })); }
    get qTrendGeom() { return this.lineChartGeometry(this.state.qc_trend); }
    get qIpqcByOperationRows() {
        const r = this.state.ipqc_by_operation_chart;
        return (r.labels || []).map((label, i) => {
            const pass = r.pass[i] || 0, fail = r.fail[i] || 0, total = Math.max(pass + fail, 1);
            return { label, pass, fail, passPct: Math.round((pass / total) * 100), failPct: Math.round((fail / total) * 100) };
        });
    }
    // residue_screening = { labels: [...result categories, e.g. Not Tested /
    // Not Detected / Detected], antibiotic: [count per category], sulphite:
    // [count per category] } - one segmented row per test, exactly like the
    // mockup's "Residue screening" card.
    get qResidueRows() {
        const r = this.state.residue_screening;
        const labels = r.labels || [];
        const colorFor = (label) => {
            if (/detect/i.test(label) && !/not/i.test(label)) return AquaDashboard.COLORS.coral;
            if (/not.?detect/i.test(label)) return AquaDashboard.COLORS.green;
            return '#D9DEE4';
        };
        const rowFor = (key, title) => {
            const vals = r[key] || [];
            const total = vals.reduce((s, v) => s + (v || 0), 0) || 1;
            const segs = labels.map((label, i) => ({
                label, value: vals[i] || 0,
                pct: Math.max(vals[i] ? 2 : 0, Math.round(((vals[i] || 0) / total) * 100)),
                color: colorFor(label),
            }));
            return { title, segs };
        };
        return [rowFor('antibiotic', 'Antibiotic'), rowFor('sulphite', 'Sulphite')];
    }

    // ---- Budget tab ----

    get budgetPairRows() {
        const rows = this.state.budget_chart;
        const max = Math.max(...rows.map((r) => Math.max(r.planned || 0, r.practical || 0)), 1);
        return rows.map((r) => ({
            ...r,
            plannedPct: Math.max(2, Math.round(((r.planned || 0) / max) * 100)),
            practicalPct: Math.max(2, Math.round(((r.practical || 0) / max) * 100)),
        }));
    }

    // ---- Drill-down: KPI tile clicks ----

    onDrillTotalReceipts() {
        this._openDrill('total_receipts', null, 'All Catch Receipts');
    }

    onDrillAcceptedReceipts() {
        this._openDrill('accepted_receipts', null, 'Completed Catch Receipts');
    }

    onDrillCancelledReceipts() {
        this._openDrill('cancelled_receipts', null, 'Cancelled Catch Receipts');
    }

    onDrillTotalWeightReceived() {
        this._openDrill('total_weight_received', null, 'All Catch Receipts by Weight');
    }

    onDrillActiveVendors() {
        this._openDrill('active_vendor_count', null, 'Active Vendors');
    }

    onDrillTotalPurchaseSpend() {
        this._openDrill('total_purchase_spend', null, 'Confirmed Purchase Orders');
    }

    onDrillTotalStockOnHand() {
        this._openDrill('total_stock_on_hand', null, "Current Stock On Hand");
    }

    onDrillStockValue() {
        this._openDrill('stock_value', null, "Current Stock Value");
    }

    onDrillQcPassRate() {
        this._openDrill('qc_pass_rate', null, 'Passed QC Checks');
    }

    onDrillDispatchRate() {
        this._openDrill('on_time_dispatch_rate', null, 'Dispatched / Delivered Shipments');
    }

    onDrillTotalProcessingOrders() {
        this._openDrill('total_processing_orders', null, 'All Processing Orders');
    }

    // "Resource monitoring" (Overview) is a synthetic five-way mass-flow
    // breakdown built from several existing aggregates (see
    // ovResourceMonitoringParts) rather than one queryable model of its
    // own, so a click routes to whichever real drill-down already backs
    // that number elsewhere on the dashboard instead of a dedicated
    // "resource monitoring" drill type that the backend has never heard of.
    onResourceMonitoringChartClick(ctx) {
        const DRILL_BY_LABEL = {
            'Raw material':      ['total_weight_received', null, 'All Catch Receipts by Weight'],
            'Production output':  ['total_processing_orders', null, 'All Processing Orders'],
            'Frozen stock in':    ['wip_stock_kg', null, 'Raw Material Staged for Processing'],
            'Frozen stock out':   ['total_stock_on_hand', null, 'Current Stock On Hand'],
            'Others / waste':     ['cancelled_receipts', null, 'Cancelled Catch Receipts'],
        };
        const entry = DRILL_BY_LABEL[ctx.label];
        if (!entry) return;
        this._openDrill(entry[0], entry[1], entry[2]);
    }

    onDrillWipStock() {
        this._openDrill('wip_stock_kg', null, 'Raw Material Staged for Processing');
    }

    onDrillQcTotal() {
        this._openDrill('qc_total', null, 'All Quality Checks');
    }

    onDrillQcFail() {
        this._openDrill('qc_fail_count', null, 'Failed Quality Checks');
    }

    onDrillQcHold() {
        this._openDrill('qc_hold_count', null, 'On-Hold Quality Checks');
    }

    onDrillIqcTotal() {
        this._openDrill('iqc_total', null, 'IQC — Incoming Quality Checks');
    }

    onDrillIpqcTotal() {
        this._openDrill('ipqc_total', null, 'IPQC — In-Process Quality Checks');
    }

    onDrillFinalQcTotal() {
        this._openDrill('final_qc_total', null, 'Final QC — Pre-Shipment Checks');
    }

    onIpqcByOperationChartClick(ctx) {
        this._openDrill('ipqc_by_operation_chart', ctx.label, `IPQC — ${ctx.label}`);
    }

    // ---- Drill-down: chart element clicks ----
    // Each ChartWidget fires onElementClick({label, dataset, index}) - the
    // label is the clicked bar/slice's category, which maps straight onto
    // the matching backend drill_type + filter_value.

    onSpeciesChartClick(ctx) {
        this._openDrill('species', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    onQcChartClick(ctx) {
        this._openDrill('qc_breakdown', ctx.label, `QC Checks — ${ctx.label}`);
    }

    onShipmentChartClick(ctx) {
        this._openDrill('shipment_breakdown', ctx.label, `Shipments — ${ctx.label}`);
    }

    onReceiptTrendChartClick(ctx) {
        this._openDrill('receipt_trend', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    /**
     * Shared hover handler for the hand-drawn SVG trend lines (these don't
     * go through Chart.js/ChartWidget, so they don't get its tooltip for
     * free). Positions a styled HTML tooltip - matching the one used by
     * ChartWidget - relative to the hovered point's own SVG circle, so it
     * stays anchored correctly regardless of the card's size on screen.
     * @param {MouseEvent} ev - the mouseenter event on the invisible hit-circle
     * @param {string} text - pre-formatted tooltip text, e.g. "Jul 2026: 40.30K kg"
     */
    onSvgPointEnter(ev, text) {
        // position:fixed + viewport coordinates, so this works regardless of
        // which card/scroll-container the hovered point sits in.
        const ptRect = ev.currentTarget.getBoundingClientRect();
        this.svgTooltip.visible = true;
        this.svgTooltip.text = text;
        this.svgTooltip.x = ptRect.left + ptRect.width / 2;
        this.svgTooltip.y = ptRect.top;
    }

    onSvgPointLeave() {
        this.svgTooltip.visible = false;
    }

    onColdRoomChartClick(ctx) {
        const room = this.state.cold_room_utilization.find((r) => r.name === ctx.label);
        if (!room) return;
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'aqua.cold.room',
            res_id: room.id,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    onReceiptStatusChartClick(ctx) {
        this._openDrill('receipt_status_breakdown', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    onSpendByVendorChartClick(ctx) {
        this._openDrill('spend_by_vendor', ctx.label, `Purchase Orders — ${ctx.label}`);
    }

    onWeightByVendorChartClick(ctx) {
        this._openDrill('weight_by_vendor', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    onOrderedVsReceivedChartClick(ctx) {
        this._openDrill('ordered_vs_received', ctx.label, `Catch Receipt — ${ctx.label}`);
    }

    onCurrentStockByProductChartClick(ctx) {
        this._openDrill('current_stock_by_product', ctx.label, `Current Stock — ${ctx.label}`);
    }

    onCurrentStockByLocationChartClick(ctx) {
        this._openDrill('current_stock_by_location', ctx.label, `Current Stock — ${ctx.label}`);
    }

    onPurchaseToStockFunnelChartClick(ctx) {
        this._openDrill('purchase_to_stock_funnel', ctx.label, `Purchase to Stock — ${ctx.label}`);
    }

    onDailyWeightTrendChartClick(ctx) {
        this._openDrill('daily_weight_trend', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    onPurchaseSpendTrendChartClick(ctx) {
        this._openDrill('purchase_spend_trend', ctx.label, `Purchase Orders — ${ctx.label}`);
    }

    onAvgPriceTrendChartClick(ctx) {
        this._openDrill('avg_price_per_kg_trend', ctx.label, `Catch Receipts — ${ctx.label}`);
    }

    onRecentDeliveryRowClick(pickingId) {
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'stock.picking',
            res_id: pickingId,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    onRecentReceiptRowClick(receiptId) {
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'aqua.catch.receipt',
            res_id: receiptId,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    onProcessingStatusChartClick(ctx) {
        this._openDrill('processing_status_breakdown', ctx.label, `Processing Orders — ${ctx.label}`);
    }

    onInputQtyBySpeciesChartClick(ctx) {
        this._openDrill('input_qty_by_species', ctx.label, `Processing Orders — ${ctx.label}`);
    }

    onWipStockByProductChartClick(ctx) {
        this._openDrill('wip_stock_by_product', ctx.label, `Staged for Processing — ${ctx.label}`);
    }

    onBlastFreezeChartClick(ctx) {
        this._openDrill('blast_freeze_status', ctx.label, `Blast Freeze Cycles — ${ctx.label}`);
    }

    onRecentProcessingRowClick(orderId) {
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'mrp.production',
            res_id: orderId,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    onQcStageChartClick(ctx) {
        this._openDrill('qc_stage_breakdown', ctx.label, `QC Checks — ${ctx.label}`);
    }

    onIntakeDecisionChartClick(ctx) {
        this._openDrill('intake_decision_breakdown', ctx.label, `Raw Material Checks — ${ctx.label}`);
    }

    onQcTrendChartClick(ctx) {
        this._openDrill('qc_trend', ctx.label, `Quality Checks — ${ctx.label}`);
    }

    onRejectedQtyBySpeciesChartClick(ctx) {
        this._openDrill('rejected_qty_by_species', ctx.label, `Rejected Quantity — ${ctx.label}`);
    }

    onRecentQcRowClick(checkId) {
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'quality.check',
            res_id: checkId,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    // ---- Drill panel plumbing ----

    async _openDrill(drillType, filterValue, title) {
        this.state.drill.isOpen = true;
        this.state.drill.title = title;
        this.state.drill.loading = true;
        this.state.drill.records = [];
        this.state.drill.columns = [];
        try {
            const result = await this.orm.call(
                "aqua.dashboard", "get_drill_records",
                [this._dashboardIds, drillType, filterValue]
            );
            this.state.drill.model = result.model;
            this.state.drill.columns = result.columns || [];
            this.state.drill.records = result.records || [];
        } catch (e) {
            this.notification.add("Failed to load records", { type: "warning" });
        } finally {
            this.state.drill.loading = false;
        }
    }

    closeDrill() {
        this.state.drill.isOpen = false;
    }

    // ==========================================================================
    // Liquid ripple
    //
    // A direct WebGL port of the reference effect: a real fluid simulation
    // (velocity + dye advected through a divergence/pressure solve, exactly
    // the "stable fluids" technique) that displaces a texture per-pixel via
    // a fragment shader - see https://liquid-image.learnframer.site/ and
    // the CodePen behind it, https://codepen.io/ksenia-k/pen/jENEMjN
    // (itself built on Pavel Dobryakov's fluid sim,
    // https://codepen.io/PavelDoGreat/pen/zdWzEL).
    //
    // An earlier version of this effect ran on the 2D canvas API: a coarse
    // grid of tiles, each redrawn from a screenshot at a small sine-based
    // offset. That is fundamentally the wrong tool for this job. A tiled
    // copy-and-offset approach is fine on a smooth photograph (which is
    // all the reference ever distorts) but breaks visibly on crisp UI
    // text and icons: the moment a displacement boundary crosses through a
    // letterform, that letter visibly tears, because neighbouring pixels a
    // few px apart suddenly sample from different, discontinuous source
    // offsets. No amount of tuning grid size or amplitude fixes that - the
    // discontinuity is the tiling itself. The reference never has this
    // problem because its shader computes a smooth, continuous, per-pixel
    // UV offset (via a velocity field sampled with bilinear filtering) -
    // there is no grid to see the seams of. Reproducing that fully
    // therefore means reproducing the actual technique, not a CPU/2D
    // approximation of its silhouette: real WebGL textures, a real
    // divergence-free velocity field, sampled continuously.
    //
    // What's kept from the reference, faithfully:
    //  - The full simulation pipeline and its constants: splat -> solve
    //    divergence -> 16-iteration Jacobi pressure solve -> subtract the
    //    pressure gradient (making the field divergence-free, which is
    //    what makes disturbances curl into little vortices instead of
    //    just smearing) -> self-advect velocity -> advect the "dye" field
    //    that the display pass reads its displacement strength from.
    //  - The exact same shaders for every one of those steps (see the
    //    LIQUID_*_SRC constants below) - only the final display shader
    //    differs, and only where it has to (see below).
    //  - The same manual bilinear-sampling trick (`bilerp()`) the
    //    reference uses in its advection shader, wherever this needs to
    //    read a velocity/dye value smoothly. This one is *load-bearing*:
    //    WebGL1 doesn't guarantee LINEAR filtering on floating-point
    //    textures, so both the reference and this port build bilinear
    //    sampling out of four NEAREST reads instead of trusting hardware
    //    filtering - without it, the low-resolution simulation grid would
    //    show through as blocky steps, reintroducing the exact "visible
    //    seams" problem this rewrite exists to fix.
    //
    // What's deliberately different, and why:
    //  - The "photo" being distorted is a live thing, not a fixed image:
    //    `canvas` can only ever draw from an image/canvas/video source,
    //    never the DOM directly, so a periodic html2canvas screenshot of
    //    the real dashboard (every card, chart, gap) is captured on a
    //    timer and re-uploaded into a texture (see _liquidTakeSnapshot).
    //  - The reference always paints a full-bleed photo - there's nothing
    //    behind its canvas to show through. Here, the real dashboard *is*
    //    what's behind the canvas, so the display shader outputs alpha 0
    //    wherever nothing is currently disturbed (derived from the same
    //    dye density that drives the displacement itself), letting the
    //    real DOM show through untouched. Nothing is drawn "on top" of
    //    calm content - hence no lens, frame, or edge anywhere.
    //  - The reference runs its simulation at the same resolution as the
    //    display canvas (confirmed straight from its own source: its
    //    `resizeCanvas()` sets the sim's `res.w/h` to literally
    //    `canvasEl.width/height` - no downsampling at all). This port
    //    follows the same approach: the velocity/pressure/divergence
    //    solve runs at close to the dashboard's own display resolution,
    //    which is what gives the swirls their crisp, richly-detailed
    //    edges rather than a soft blur. It's still capped
    //    (LIQUID_SIM_RESOLUTION) rather than fully uncapped, because a
    //    scrollable dashboard can be considerably taller than the single
    //    browser window the reference always runs in - the cap only
    //    matters on unusually long pages, and is high enough that it
    //    never engages on an ordinary viewport-sized one. The dye field
    //    gets its own, higher-still cap (LIQUID_DYE_RESOLUTION) for extra
    //    swirl detail, which the reference's own advection shader already
    //    supports natively (it takes the advected field's texel size as a
    //    parameter separate from the velocity field's) - this isn't a
    //    deviation so much as using a knob the original shader always had.
    //  - The reference's idle preview drifts the splat point in a lazy
    //    Lissajous curve before you've touched it - nice for a demo page,
    //    not for a data dashboard someone is trying to read. This version
    //    only ever reacts to a real cursor/touch and sits perfectly still
    //    (and fully invisible) otherwise.
    // ==========================================================================

    // ---- Vertex shader shared by every program below ----
    static LIQUID_VERT_SRC = `
        precision highp float;

        varying vec2 vUv;
        attribute vec2 a_position;

        varying vec2 vL;
        varying vec2 vR;
        varying vec2 vT;
        varying vec2 vB;
        uniform vec2 u_texel;

        void main () {
            vUv = .5 * (a_position + 1.);
            vL = vUv - vec2(u_texel.x, 0.);
            vR = vUv + vec2(u_texel.x, 0.);
            vT = vUv + vec2(0., u_texel.y);
            vB = vUv - vec2(0., u_texel.y);
            gl_Position = vec4(a_position, 0., 1.);
        }
    `;

    // ---- Splats a pointer-movement impulse into whatever field it's targeting ----
    static LIQUID_SPLAT_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D u_input_texture;
        uniform float u_ratio;
        uniform vec3 u_point_value;
        uniform vec2 u_point;
        uniform float u_point_size;

        void main () {
            vec2 p = vUv - u_point.xy;
            p.x *= u_ratio;
            vec3 splat = .6 * pow(2., -dot(p, p) / u_point_size) * u_point_value;

            vec3 base = texture2D(u_input_texture, vUv).xyz;
            gl_FragColor = vec4(base + splat, 1.);
        }
    `;

    static LIQUID_DIVERGENCE_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_velocity_texture;

        void main () {
            float L = texture2D(u_velocity_texture, vL).x;
            float R = texture2D(u_velocity_texture, vR).x;
            float T = texture2D(u_velocity_texture, vT).y;
            float B = texture2D(u_velocity_texture, vB).y;

            float div = .25 * (R - L + T - B);
            gl_FragColor = vec4(div, 0., 0., 1.);
        }
    `;

    static LIQUID_PRESSURE_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_pressure_texture;
        uniform sampler2D u_divergence_texture;

        void main () {
            float L = texture2D(u_pressure_texture, vL).x;
            float R = texture2D(u_pressure_texture, vR).x;
            float T = texture2D(u_pressure_texture, vT).x;
            float B = texture2D(u_pressure_texture, vB).x;
            float divergence = texture2D(u_divergence_texture, vUv).x;
            float pressure = (L + R + B + T - divergence) * .25;

            gl_FragColor = vec4(pressure, 0., 0., 1.);
        }
    `;

    static LIQUID_GRADIENT_SUBTRACT_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying highp vec2 vUv;
        varying highp vec2 vL;
        varying highp vec2 vR;
        varying highp vec2 vT;
        varying highp vec2 vB;
        uniform sampler2D u_pressure_texture;
        uniform sampler2D u_velocity_texture;

        void main () {
            float L = texture2D(u_pressure_texture, vL).x;
            float R = texture2D(u_pressure_texture, vR).x;
            float T = texture2D(u_pressure_texture, vT).x;
            float B = texture2D(u_pressure_texture, vB).x;
            vec2 velocity = texture2D(u_velocity_texture, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            gl_FragColor = vec4(velocity, 0., 1.);
        }
    `;

    // Reused for both the velocity self-advection pass and the dye
    // advection pass below - u_texel always describes the *velocity*
    // field's own resolution (it's what's used to look up the flow at
    // vUv), while u_output_textel describes whichever field is actually
    // being carried along (u_input_texture) - velocity's own resolution
    // when advecting itself, the dye field's resolution when advecting
    // dye. See _liquidSimulate for exactly how these get set per call.
    static LIQUID_ADVECTION_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform sampler2D u_velocity_texture;
        uniform sampler2D u_input_texture;
        uniform vec2 u_texel;
        uniform vec2 u_output_textel;
        uniform float u_dt;
        uniform float u_dissipation;

        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;

            vec2 iuv = floor(st);
            vec2 fuv = fract(st);

            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }

        void main () {
            vec2 coord = vUv - u_dt * bilerp(u_velocity_texture, vUv, u_texel).xy * u_texel;
            vec4 velocity = bilerp(u_input_texture, coord, u_output_textel);
            gl_FragColor = u_dissipation * velocity;
        }
    `;

    // The one shader that genuinely differs from the reference, and only
    // by what it has to: no image-aspect-ratio "cover" correction (the
    // snapshot texture is always exactly the same aspect ratio as the
    // canvas, since it's a screenshot of the very thing the canvas
    // overlays - unlike the reference, which fits an arbitrary photo into
    // its frame), and alpha derived from disturbance instead of a
    // constant 1 (so untouched dashboard content shows through instead of
    // being covered by a static "frame"). Both texture reads that feed
    // the displacement go through the same manual `bilerp()` the
    // advection shader above uses, and for the same reason: sampling the
    // low-resolution velocity/dye fields with plain NEAREST texture2D
    // here would reintroduce a blocky step every few screen pixels,
    // right back to the "visible seams on text" problem this rewrite
    // exists to fix.
    static LIQUID_DISPLAY_SRC = `
        precision highp float;
        precision highp sampler2D;

        varying vec2 vUv;
        uniform vec2 u_sim_texel;
        uniform vec2 u_dye_texel;
        uniform float u_disturb_power;
        uniform sampler2D u_output_texture;
        uniform sampler2D u_velocity_texture;
        uniform sampler2D u_text_texture;

        vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
            vec2 st = uv / tsize - 0.5;

            vec2 iuv = floor(st);
            vec2 fuv = fract(st);

            vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
            vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
            vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
            vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

            return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
        }

        void main () {
            float offset = bilerp(u_output_texture, vUv, u_dye_texel).r;
            vec2 velocity = bilerp(u_velocity_texture, vUv, u_sim_texel).xy;
            vec2 dir = velocity + vec2(0.0008, 0.0006);
            vec2 uv = vUv - u_disturb_power * normalize(dir) * offset;
            uv = clamp(uv, 0.0, 1.0);
            vec3 img = texture2D(u_text_texture, vec2(uv.x, 1.0 - uv.y)).rgb;
            // Fully transparent at rest; fades in with how disturbed this
            // patch currently is - there is no frame, edge or shape to
            // this effect beyond that, on purpose. The upper edge here is
            // tuned alongside LIQUID_SPLAT_DYE_POWER above: wide enough
            // that reaching full opacity still reads as a gradual fade
            // rather than a hard on/off flicker.
            float alpha = smoothstep(0.0, 0.16, offset);
            gl_FragColor = vec4(img, alpha);
        }
    `;

    // Everything from here down is the same handful of tuning numbers the
    // reference itself uses (splat force, dye/cursor "power", dissipation
    // rates, distortion power), carried over as-is - see the CodePen
    // linked above for their `params` object and `updatePointerPosition` -
    // with two deliberate exceptions: the resolution caps (explained
    // above _initLiquidLens) and LIQUID_SPLAT_DYE_POWER, bumped up from
    // the reference's own default of .024 (24 * .001) to sit closer to
    // the strong, richly-swirled look their own "cursorPower" slider
    // produces around 55-60 - a livelier result than the demo's
    // out-of-the-box default is the better fit for something meant to
    // actually be noticed on a dashboard someone is moving their mouse
    // across, rather than a deliberately understated starting point meant
    // to be tuned upward by hand via a GUI slider.
    static LIQUID_SIM_RESOLUTION = 480;
    static LIQUID_DYE_RESOLUTION = 960;
    static LIQUID_PRESSURE_ITERATIONS = 16;
    static LIQUID_SNAPSHOT_INTERVAL_MS = 1500;
    static LIQUID_VELOCITY_DT = 1 / 60;
    static LIQUID_VELOCITY_DISSIPATION = .97;
    static LIQUID_DYE_DISSIPATION = .98;
    static LIQUID_DYE_DT_MULT = 8;
    static LIQUID_SPLAT_FORCE = 6;
    static LIQUID_SPLAT_SIZE = .002;
    static LIQUID_SPLAT_DYE_POWER = .056;
    static LIQUID_DISTURB_POWER = .4;

    _initLiquidLens() {
        const lensEl = this.liquidLensRef.el;
        const canvasEl = this.liquidLensCanvasRef.el;
        if (!lensEl || !canvasEl) return;
        const rootEl = lensEl.parentElement;
        if (!rootEl) return;

        // Every prerequisite gets checked up front and bails out quietly
        // on failure - the dashboard is fully usable without this effect,
        // so a missing dependency should never be user-visible as
        // anything worse than "no ripple".
        if (typeof window.html2canvas !== "function") return;
        if (typeof ResizeObserver !== "function") return;

        const gl = canvasEl.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false })
            || canvasEl.getContext("experimental-webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
        if (!gl) return;
        // The velocity/pressure/divergence/dye fields are floating-point
        // textures (they hold signed, unbounded values, not 0..1 colour) -
        // not supported on WebGL1 without this extension.
        if (!gl.getExtension("OES_texture_float")) return;

        const vertexShader = this._liquidCompileShader(gl, AquaDashboard.LIQUID_VERT_SRC, gl.VERTEX_SHADER);
        if (!vertexShader) return;

        const programs = {
            splatProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_SPLAT_SRC),
            divergenceProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_DIVERGENCE_SRC),
            pressureProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_PRESSURE_SRC),
            gradientSubtractProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_GRADIENT_SUBTRACT_SRC),
            advectionProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_ADVECTION_SRC),
            displayProgram: this._liquidCreateProgram(gl, vertexShader, AquaDashboard.LIQUID_DISPLAY_SRC),
        };
        if (Object.values(programs).some((p) => !p)) {
            // A shader failed to compile/link - extremely unusual, but
            // possible on an old/unusual GPU driver. Bail rather than run
            // with a partially-broken pipeline.
            return;
        }

        const quadVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
        const quadIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        // Every program above was linked with a_position pinned to
        // location 0 (see _liquidCreateProgram), so this only needs
        // doing once - it stays valid across every gl.useProgram() switch
        // in the render loop below.
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);

        const liquid = {
            rootEl, lensEl, canvasEl, gl, programs, quadVbo, quadIbo,
            dpr: Math.min(window.devicePixelRatio || 1, 2),
            width: 0, height: 0,
            velocity: null, divergence: null, pressure: null, dye: null,
            simTexel: { x: 0, y: 0 },
            dyeTexel: { x: 0, y: 0 },
            textTexture: null,
            pointer: { x: 0, y: 0, dx: 0, dy: 0, moved: false },
            hasEntered: false,
            destroyed: false,
            rafId: null,
            snapshotTimer: null,
            snapshotMismatch: false,
            resizeObserver: null,
        };
        this._liquid = liquid;

        // The live DOM snapshot lands in this texture (see
        // _liquidTakeSnapshot). LINEAR is safe here - unlike the FLOAT
        // simulation textures above, this is a plain UNSIGNED_BYTE RGBA
        // texture, which every WebGL1 implementation can filter natively.
        liquid.textTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, liquid.textTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // 1x1 fully-transparent placeholder until the first snapshot lands.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

        if (!this._liquidResize(liquid)) {
            this._teardownLiquidLens();
            return;
        }

        liquid.onPointerMove = (ev) => {
            const r = rootEl.getBoundingClientRect();
            this._liquidUpdatePointer(liquid, ev.clientX - r.left, ev.clientY - r.top);
        };
        liquid.onTouchMove = (ev) => {
            if (!ev.targetTouches.length) return;
            const r = rootEl.getBoundingClientRect();
            const t = ev.targetTouches[0];
            this._liquidUpdatePointer(liquid, t.clientX - r.left, t.clientY - r.top);
        };
        liquid.onMouseEnter = (ev) => {
            const r = rootEl.getBoundingClientRect();
            // Snap straight to the entry point rather than treating the
            // jump from wherever the pointer last was as a giant splat.
            liquid.pointer.x = ev.clientX - r.left;
            liquid.pointer.y = ev.clientY - r.top;
            liquid.hasEntered = true;
        };
        // Bound to the dashboard root (not the canvas): the canvas is
        // pointer-events:none specifically so it never blocks clicks on
        // the real UI it's disturbing, which means the root - not the
        // canvas - is what actually receives these events.
        rootEl.addEventListener("mousemove", liquid.onPointerMove);
        rootEl.addEventListener("touchmove", liquid.onTouchMove, { passive: true });
        rootEl.addEventListener("mouseenter", liquid.onMouseEnter);

        // A ResizeObserver rather than a window "resize" listener: the
        // dashboard's own height changes for lots of reasons that have
        // nothing to do with the window - switching tabs, a chart
        // finishing its first render, a drill-down panel opening.
        liquid.resizeObserver = new ResizeObserver(() => {
            if (!this._liquidResize(liquid)) {
                this._teardownLiquidLens();
                return;
            }
            this._liquidScheduleSnapshot(150);
        });
        liquid.resizeObserver.observe(rootEl);

        // A short initial delay, not an immediate capture: right at mount
        // is exactly when async widgets (weather, charts, CountUp
        // animations) are least likely to have settled yet, and the
        // mismatch self-correction in _liquidTakeSnapshot can then only
        // narrow the resulting gap after the fact, not prevent it.
        this._liquidScheduleSnapshot(300);
        liquid.rafId = requestAnimationFrame(() => this._liquidTick());
    }

    _teardownLiquidLens() {
        const liquid = this._liquid;
        if (!liquid) return;
        liquid.destroyed = true;
        if (liquid.rafId) cancelAnimationFrame(liquid.rafId);
        if (liquid.snapshotTimer) clearTimeout(liquid.snapshotTimer);
        if (liquid.resizeObserver) liquid.resizeObserver.disconnect();
        liquid.rootEl.removeEventListener("mousemove", liquid.onPointerMove);
        liquid.rootEl.removeEventListener("touchmove", liquid.onTouchMove);
        liquid.rootEl.removeEventListener("mouseenter", liquid.onMouseEnter);

        // Explicitly release every GPU resource rather than leaving it to
        // garbage collection - this component can mount and unmount many
        // times as someone navigates in and out of the dashboard action,
        // and WebGL contexts/textures are not cheap to leave dangling.
        const { gl } = liquid;
        if (gl) {
            this._liquidDeleteDoubleFBO(gl, liquid.velocity);
            this._liquidDeleteFBO(gl, liquid.divergence);
            this._liquidDeleteDoubleFBO(gl, liquid.pressure);
            this._liquidDeleteDoubleFBO(gl, liquid.dye);
            if (liquid.textTexture) gl.deleteTexture(liquid.textTexture);
            if (liquid.quadVbo) gl.deleteBuffer(liquid.quadVbo);
            if (liquid.quadIbo) gl.deleteBuffer(liquid.quadIbo);
            for (const key of Object.keys(liquid.programs || {})) {
                const p = liquid.programs[key];
                if (p && p.program) gl.deleteProgram(p.program);
            }
            // Losing the context outright hands the GPU memory back
            // immediately instead of waiting on the canvas element itself
            // to be garbage-collected.
            const loseCtx = gl.getExtension("WEBGL_lose_context");
            if (loseCtx) loseCtx.loseContext();
        }

        this._liquid = null;
    }

    _liquidCompileShader(gl, source, type) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error("Liquid ripple: shader compile error:", gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    _liquidCreateProgram(gl, vertexShader, fragmentSource) {
        const fragmentShader = this._liquidCompileShader(gl, fragmentSource, gl.FRAGMENT_SHADER);
        if (!fragmentShader) return null;
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        // Pin a_position to a known location before linking so every
        // program agrees on it - that's what lets the fullscreen-quad
        // buffer be bound once (in _initLiquidLens) and reused across
        // every gl.useProgram() switch in the render loop.
        gl.bindAttribLocation(program, 0, "a_position");
        gl.linkProgram(program);
        gl.deleteShader(fragmentShader);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Liquid ripple: program link error:", gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            return null;
        }
        return { program, uniforms: this._liquidGetUniforms(gl, program) };
    }

    _liquidGetUniforms(gl, program) {
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name] = gl.getUniformLocation(program, info.name);
        }
        return uniforms;
    }

    // Creates one float-texture render target. Returns null (after
    // cleaning up after itself) if this GPU/driver can create a
    // floating-point texture but can't actually render into one - rare,
    // but real on some older/mobile drivers, and worth checking
    // explicitly rather than silently producing a broken effect.
    _liquidCreateFBO(gl, w, h) {
        gl.activeTexture(gl.TEXTURE0);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(texture);
            return null;
        }

        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        return {
            fbo, texture, width: w, height: h,
            attach(unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, texture);
                return unit;
            },
        };
    }

    _liquidCreateDoubleFBO(gl, w, h) {
        const a = this._liquidCreateFBO(gl, w, h);
        const b = this._liquidCreateFBO(gl, w, h);
        if (!a || !b) {
            if (a) this._liquidDeleteFBO(gl, a);
            if (b) this._liquidDeleteFBO(gl, b);
            return null;
        }
        let read = a;
        let write = b;
        return {
            width: w, height: h,
            texelSizeX: 1 / w, texelSizeY: 1 / h,
            read: () => read,
            write: () => write,
            swap() { const t = read; read = write; write = t; },
        };
    }

    _liquidDeleteFBO(gl, fboObj) {
        if (!fboObj) return;
        gl.deleteFramebuffer(fboObj.fbo);
        gl.deleteTexture(fboObj.texture);
    }

    _liquidDeleteDoubleFBO(gl, doubleFboObj) {
        if (!doubleFboObj) return;
        this._liquidDeleteFBO(gl, doubleFboObj.read());
        this._liquidDeleteFBO(gl, doubleFboObj.write());
    }

    // Picks a grid size that preserves the dashboard's own aspect ratio -
    // needed so splats stay circular (see u_ratio in LIQUID_SPLAT_SRC) and
    // nothing looks stretched.
    _liquidFitResolution(width, height, maxDim) {
        const aspect = width / height;
        if (aspect >= 1) {
            return { w: maxDim, h: Math.max(1, Math.round(maxDim / aspect)) };
        }
        return { w: Math.max(1, Math.round(maxDim * aspect)), h: maxDim };
    }

    // (Re)sizes the canvas to cover the dashboard root edge-to-edge and
    // rebuilds every simulation buffer to match. Called on mount, whenever
    // the root's own box size changes, and speculatively after every
    // snapshot (see _liquidTakeSnapshot) to catch async content that
    // reflowed the page without a discrete resize event ever firing.
    // Deliberately a cheap no-op when the size hasn't actually moved -
    // reallocating throws away the simulation's current velocity/dye
    // state, which would otherwise make ripples visibly "reset" every
    // time this got called defensively rather than only on a real change.
    // Returns false if a buffer failed to allocate (see
    // _liquidCreateFBO), in which case the caller tears the whole effect
    // down rather than run with a broken pipeline.
    _liquidResize(liquid) {
        const { gl, rootEl, canvasEl, dpr } = liquid;
        const width = Math.max(1, rootEl.clientWidth);
        const height = Math.max(1, rootEl.clientHeight);
        if (liquid.velocity && width === liquid.width && height === liquid.height) {
            return true;
        }
        liquid.width = width;
        liquid.height = height;

        canvasEl.style.width = width + "px";
        canvasEl.style.height = height + "px";
        canvasEl.width = Math.round(width * dpr);
        canvasEl.height = Math.round(height * dpr);

        this._liquidDeleteDoubleFBO(gl, liquid.velocity);
        this._liquidDeleteFBO(gl, liquid.divergence);
        this._liquidDeleteDoubleFBO(gl, liquid.pressure);
        this._liquidDeleteDoubleFBO(gl, liquid.dye);

        const simSize = this._liquidFitResolution(width, height, AquaDashboard.LIQUID_SIM_RESOLUTION);
        const dyeSize = this._liquidFitResolution(width, height, AquaDashboard.LIQUID_DYE_RESOLUTION);

        liquid.velocity = this._liquidCreateDoubleFBO(gl, simSize.w, simSize.h);
        liquid.divergence = this._liquidCreateFBO(gl, simSize.w, simSize.h);
        liquid.pressure = this._liquidCreateDoubleFBO(gl, simSize.w, simSize.h);
        liquid.dye = this._liquidCreateDoubleFBO(gl, dyeSize.w, dyeSize.h);
        liquid.simTexel = { x: 1 / simSize.w, y: 1 / simSize.h };
        liquid.dyeTexel = { x: 1 / dyeSize.w, y: 1 / dyeSize.h };

        return !!(liquid.velocity && liquid.divergence && liquid.pressure && liquid.dye);
    }

    _liquidUpdatePointer(liquid, x, y) {
        if (!liquid.hasEntered) {
            // First move before any mouseenter fired (e.g. the pointer
            // was already sitting over the dashboard when it mounted) -
            // snap rather than splatting in from (0, 0).
            liquid.pointer.x = x;
            liquid.pointer.y = y;
            liquid.hasEntered = true;
            return;
        }
        liquid.pointer.dx = AquaDashboard.LIQUID_SPLAT_FORCE * (x - liquid.pointer.x);
        liquid.pointer.dy = AquaDashboard.LIQUID_SPLAT_FORCE * (y - liquid.pointer.y);
        liquid.pointer.x = x;
        liquid.pointer.y = y;
        liquid.pointer.moved = true;
    }

    // Grabs a fresh html2canvas screenshot of the whole dashboard root and
    // uploads it into the texture the display shader reads from (see
    // LIQUID_DISPLAY_SRC / _liquidDisplay). Re-runs itself on a timer -
    // and can be nudged to run sooner (a resize, a just-finished previous
    // capture) via the `delayMs` argument - but never overlaps two
    // captures at once.
    _liquidScheduleSnapshot(delayMs) {
        const liquid = this._liquid;
        if (!liquid || liquid.destroyed) return;
        if (liquid.snapshotTimer) clearTimeout(liquid.snapshotTimer);
        liquid.snapshotTimer = setTimeout(() => this._liquidTakeSnapshot(), delayMs);
    }

    _liquidTakeSnapshot() {
        const liquid = this._liquid;
        if (!liquid || liquid.destroyed) return;
        window.html2canvas(liquid.rootEl, {
            backgroundColor: null,
            scale: liquid.dpr,
            logging: false,
            useCORS: true,
            // Never capture the ripple canvas itself - it sits on top of
            // the very content it's meant to be reading from.
            ignoreElements: (el) => el === liquid.lensEl,
        }).then((snapshotCanvas) => {
            if (!liquid || liquid.destroyed) return;
            const { gl } = liquid;
            gl.bindTexture(gl.TEXTURE_2D, liquid.textTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshotCanvas);

            // html2canvas is asynchronous and, on a dashboard with async
            // widgets (a weather fetch, a chart's first render, a
            // CountUp animation finishing), can take just long enough for
            // the page to reflow *while a capture is in flight*. Left
            // alone, the texture just uploaded would then represent a
            // slightly different content height than the canvas is
            // currently sized for - so wherever the effect is active,
            // the displaced content would sample from the wrong place
            // and look stretched or doubled against the real DOM under
            // it, rather than a clean ripple. Re-measure immediately
            // after every capture (cheap - see the no-op guard at the
            // top of _liquidResize) and, if the page genuinely moved
            // since this capture started, resize right away and queue a
            // fast follow-up capture instead of waiting out the full
            // interval, so any mismatch is visible for at most a
            // fraction of a second rather than up to
            // LIQUID_SNAPSHOT_INTERVAL_MS.
            const priorWidth = liquid.width;
            const priorHeight = liquid.height;
            if (!this._liquidResize(liquid)) {
                this._teardownLiquidLens();
                return;
            }
            liquid.snapshotMismatch = liquid.width !== priorWidth || liquid.height !== priorHeight;
        }).catch(() => {
            // A capture can occasionally fail (tainted canvas from a
            // cross-origin image, etc.) - keep the previous snapshot
            // rather than breaking the effect.
        }).finally(() => {
            if (!liquid || liquid.destroyed) return;
            const delay = liquid.snapshotMismatch ? 120 : AquaDashboard.LIQUID_SNAPSHOT_INTERVAL_MS;
            liquid.snapshotMismatch = false;
            this._liquidScheduleSnapshot(delay);
        });
    }

    _liquidBindTarget(liquid, target) {
        const { gl } = liquid;
        if (target == null) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.width, target.height);
        }
    }

    _liquidBlit(liquid, target) {
        this._liquidBindTarget(liquid, target);
        liquid.gl.drawElements(liquid.gl.TRIANGLES, 6, liquid.gl.UNSIGNED_SHORT, 0);
    }

    // Drives the whole effect every frame: turns pointer movement since
    // the last frame into a splat, steps the fluid simulation, then draws
    // the result over the real dashboard.
    _liquidTick() {
        const liquid = this._liquid;
        if (!liquid) return;

        if (liquid.pointer.moved) {
            liquid.pointer.moved = false;
            this._liquidSplat(liquid, liquid.pointer.x, liquid.pointer.y, liquid.pointer.dx, liquid.pointer.dy);
        }

        this._liquidSimulate(liquid);
        this._liquidDisplay(liquid);

        liquid.rafId = requestAnimationFrame(() => this._liquidTick());
    }

    // Splats a pointer-movement impulse into both the velocity field
    // (which way things should move) and the dye field (how strongly the
    // display pass should displace, independent of direction) - exactly
    // the reference's two-splat-per-move pattern.
    _liquidSplat(liquid, x, y, dx, dy) {
        const { gl, velocity, dye, programs } = liquid;
        const { splatProgram } = programs;
        const u = x / liquid.width;
        const v = 1 - y / liquid.height;

        gl.useProgram(splatProgram.program);
        gl.uniform1f(splatProgram.uniforms.u_ratio, velocity.width / velocity.height);
        gl.uniform2f(splatProgram.uniforms.u_point, u, v);
        gl.uniform1f(splatProgram.uniforms.u_point_size, AquaDashboard.LIQUID_SPLAT_SIZE);

        gl.uniform1i(splatProgram.uniforms.u_input_texture, velocity.read().attach(0));
        gl.uniform3f(splatProgram.uniforms.u_point_value, dx, -dy, 0);
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        gl.uniform1i(splatProgram.uniforms.u_input_texture, dye.read().attach(0));
        gl.uniform3f(splatProgram.uniforms.u_point_value, AquaDashboard.LIQUID_SPLAT_DYE_POWER, 0, 0);
        this._liquidBlit(liquid, dye.write());
        dye.swap();
    }

    // The "stable fluids" solve, in order - this order matters:
    // projecting velocity to be divergence-free (divergence -> pressure
    // -> gradient subtract) has to happen *before* advecting anything
    // with it, or the field never develops the little vortices that read
    // as "liquid" rather than "smearing".
    _liquidSimulate(liquid) {
        const { gl, velocity, divergence, pressure, dye, programs, simTexel, dyeTexel } = liquid;
        const { divergenceProgram, pressureProgram, gradientSubtractProgram, advectionProgram } = programs;

        gl.useProgram(divergenceProgram.program);
        gl.uniform2f(divergenceProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(divergenceProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
        this._liquidBlit(liquid, divergence);

        gl.useProgram(pressureProgram.program);
        gl.uniform2f(pressureProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(pressureProgram.uniforms.u_divergence_texture, divergence.attach(1));
        for (let i = 0; i < AquaDashboard.LIQUID_PRESSURE_ITERATIONS; i++) {
            gl.uniform1i(pressureProgram.uniforms.u_pressure_texture, pressure.read().attach(0));
            this._liquidBlit(liquid, pressure.write());
            pressure.swap();
        }

        gl.useProgram(gradientSubtractProgram.program);
        gl.uniform2f(gradientSubtractProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform1i(gradientSubtractProgram.uniforms.u_pressure_texture, pressure.read().attach(0));
        gl.uniform1i(gradientSubtractProgram.uniforms.u_velocity_texture, velocity.read().attach(1));
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        // Self-advect the (now divergence-free) velocity field - this is
        // what makes a disturbance curl and drift instead of just fading
        // in place.
        gl.useProgram(advectionProgram.program);
        gl.uniform2f(advectionProgram.uniforms.u_texel, simTexel.x, simTexel.y);
        gl.uniform2f(advectionProgram.uniforms.u_output_textel, simTexel.x, simTexel.y);
        gl.uniform1i(advectionProgram.uniforms.u_velocity_texture, velocity.read().attach(0));
        gl.uniform1i(advectionProgram.uniforms.u_input_texture, velocity.read().attach(0));
        gl.uniform1f(advectionProgram.uniforms.u_dt, AquaDashboard.LIQUID_VELOCITY_DT);
        gl.uniform1f(advectionProgram.uniforms.u_dissipation, AquaDashboard.LIQUID_VELOCITY_DISSIPATION);
        this._liquidBlit(liquid, velocity.write());
        velocity.swap();

        // Carry the dye field along by that same velocity - a slower,
        // bigger timestep (matching the reference) is what makes a
        // ripple linger and drift a little after the cursor has already
        // moved on, rather than snapping to a stop.
        gl.uniform2f(advectionProgram.uniforms.u_output_textel, dyeTexel.x, dyeTexel.y);
        gl.uniform1i(advectionProgram.uniforms.u_input_texture, dye.read().attach(1));
        gl.uniform1f(advectionProgram.uniforms.u_dt, AquaDashboard.LIQUID_VELOCITY_DT * AquaDashboard.LIQUID_DYE_DT_MULT);
        gl.uniform1f(advectionProgram.uniforms.u_dissipation, AquaDashboard.LIQUID_DYE_DISSIPATION);
        this._liquidBlit(liquid, dye.write());
        dye.swap();
    }

    // Draws the final, displaced result over the real dashboard: fully
    // transparent wherever the dye field is at rest, fading in smoothly
    // wherever it isn't (see LIQUID_DISPLAY_SRC).
    _liquidDisplay(liquid) {
        const { gl, dye, velocity, textTexture, simTexel, dyeTexel, programs } = liquid;
        const { displayProgram } = programs;

        gl.useProgram(displayProgram.program);
        gl.uniform2f(displayProgram.uniforms.u_sim_texel, simTexel.x, simTexel.y);
        gl.uniform2f(displayProgram.uniforms.u_dye_texel, dyeTexel.x, dyeTexel.y);
        gl.uniform1f(displayProgram.uniforms.u_disturb_power, AquaDashboard.LIQUID_DISTURB_POWER);
        gl.uniform1i(displayProgram.uniforms.u_output_texture, dye.read().attach(0));
        gl.uniform1i(displayProgram.uniforms.u_velocity_texture, velocity.read().attach(1));
        gl.activeTexture(gl.TEXTURE0 + 2);
        gl.bindTexture(gl.TEXTURE_2D, textTexture);
        gl.uniform1i(displayProgram.uniforms.u_text_texture, 2);

        this._liquidBindTarget(liquid, null);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

}


registry.category("actions").add("aqua_dashboard_action", AquaDashboard);