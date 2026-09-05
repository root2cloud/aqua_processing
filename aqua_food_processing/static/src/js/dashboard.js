/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, useState } from "@odoo/owl";

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
        this.filters = { period: 'ytd', compare: 'none', customFrom: '', customTo: '' };
        // Hand-drawn SVG trend lines (receipt/weight/spend/QC trends) don't go
        // through Chart.js, so they need their own hover tooltip instead of
        // the native <title> attribute (which renders as a plain OS tooltip
        // that can't be styled - see svgTooltip/onSvgPointEnter below).
        this.svgTooltip = useState({ visible: false, x: 0, y: 0, text: '' });
        this.ui = useState({ heroExpanded: false });
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
        setTimeout(() => { this.search.isOpen = false; }, 150);
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
            overview: 'Aqua processing dashboard', procurement: 'Procurement',
            processing: 'Processing', quality: 'Quality control', budget: 'Budget',
        };
        return T[this.state.activeTab] || 'Aqua processing dashboard';
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

    // rows: [{label, value}] -> grid lines, polyline, filled area and end
    // points for the mockup's SVG trend-line cards.
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
        const areaPath = points.length
            ? `M${points[0].x},${baseline} L${points.map((p) => `${p.x},${p.y}`).join(' L')} L${points[points.length - 1].x},${baseline} Z`
            : '';
        const gridLines = [0, 1, 2, 3].map((i) => {
            const y = padT + (plotH / 3) * i;
            const val = maxV * (1 - i / 3);
            return { y: +y.toFixed(1), label: this._axisLabel(val) };
        });
        return {
            width, height, baseline, padL, padR, points, polyline, areaPath, gridLines,
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
}

registry.category("actions").add("aqua_dashboard_action", AquaDashboard);