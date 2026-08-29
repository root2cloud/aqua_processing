/** @odoo-module **/
/**
 * ChartWidget — reusable Chart.js wrapper for the Aqua dashboard.
 *
 * Chart.js is bundled locally with this module (static/lib/chartjs) and
 * declared as a plain web.assets_backend asset in __manifest__.py, ahead of
 * this file. That means window.Chart is already loaded and ready by the
 * time the dashboard mounts - no CDN, no network dependency, nothing to
 * silently fail offline or behind a firewall/ad-blocker.
 *
 * Supported chartType: line | bar | horizontalBar | stacked | doughnut | pie
 */
import {
    Component,
    onMounted,
    onWillUpdateProps,
    onWillUnmount,
    useRef,
} from "@odoo/owl";

export class ChartWidget extends Component {
    static template = "aqua_food_processing.ChartWidget";

    static props = {
        chartType:      { type: String },
        title:          { type: String },
        data:           { type: Object },
        options:        { type: Object,  optional: true },
        height:         { type: Number,  optional: true },
        isLoading:      { type: Boolean, optional: true },
        onElementClick: { type: Function, optional: true },
        exportFilename: { type: String,  optional: true },
    };

    // Owl only reads defaults from `static defaultProps`, never from a
    // `default:` key inside `static props` - without this,
    // this.props.options is undefined whenever a panel doesn't pass
    // `options` explicitly, and `...(options.plugins || {})` below throws.
    static defaultProps = {
        options:        {},
        height:         260,
        isLoading:      false,
        onElementClick: () => {},
        exportFilename: "aqua_chart",
    };

    setup() {
        this.canvasRef = useRef("chartCanvas");
        this._chart = null;

        onMounted(() => this._initChart());

        onWillUpdateProps((nextProps) => {
            // Do not compare nextProps.data !== this.props.data by reference:
            // every panel passes data="someGetter", and getters build a
            // brand-new {labels, datasets} object on every evaluation, even
            // when the underlying numbers haven't changed. Comparing by
            // content avoids tearing down and rebuilding the chart (and the
            // resulting flicker) on every unrelated re-render.
            const dataChanged = JSON.stringify(nextProps.data) !== JSON.stringify(this.props.data);
            const typeChanged = nextProps.chartType !== this.props.chartType;
            if (!dataChanged && !typeChanged) return;

            if (typeChanged || !this._chart) {
                this._destroyChart();
                setTimeout(() => this._initChart(), 0);
            } else {
                // Ordinary data refresh: update the existing Chart.js
                // instance in place instead of destroying/recreating it.
                // The canvas stays permanently mounted (loading spinner is
                // an overlay, not a replacement - see chart_widget.xml), so
                // Chart.js can animate the data change smoothly.
                setTimeout(() => this._updateChart(), 0);
            }
        });

        onWillUnmount(() => this._destroyChart());
    }

    _destroyChart() {
        if (this._chart) {
            this._chart.destroy();
            this._chart = null;
        }
    }

    _initChart() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        if (!window.Chart) {
            // Fail loudly instead of leaving a silent blank box.
            console.error(
                "AquaDashboard: window.Chart is not defined. Check that " +
                "static/lib/chartjs/chart.umd.js is listed in __manifest__.py " +
                "assets *before* chart_widget.js, and that the module has " +
                "been upgraded (-u aqua_food_processing) after adding it."
            );
            return;
        }
        this._destroyChart();
        const config = this._getChartJsConfig();
        if (config) {
            this._chart = new window.Chart(canvas, config);
        }
    }

    _updateChart() {
        if (!this._chart) {
            this._initChart();
            return;
        }
        const config = this._getChartJsConfig();
        if (!config) return;
        this._chart.data = config.data;
        this._chart.options = config.options;
        this._chart.update();
    }

    _getChartJsConfig() {
        const { chartType, data, options } = this.props;

        const COLORS = [
            "#2C7A7B", "#3182CE", "#D69E2E", "#C53030",
            "#805AD5", "#38A169", "#DD6B20", "#718096",
        ];

        const datasets = (data.datasets || []).map((ds, i) => ({
            backgroundColor: COLORS[i % COLORS.length] +
                (chartType === "line" ? "33" : "CC"),
            borderColor: COLORS[i % COLORS.length],
            borderWidth: 2,
            ...ds,
        }));

        const baseOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: {
                    display: datasets.length > 1,
                    position: "bottom",
                    labels: { boxWidth: 12, font: { size: 11 } },
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed ?? ctx.raw;
                            if (typeof v === "number") {
                                return ` ${new Intl.NumberFormat("en-IN", {
                                    maximumFractionDigits: 1,
                                }).format(v)}`;
                            }
                            return ` ${v}`;
                        },
                    },
                },
                ...(options.plugins || {}),
            },
            onClick: (event, elements) => {
                if (elements.length > 0) {
                    const el = elements[0];
                    const label = data.labels?.[el.index] ?? "";
                    const dataset = datasets[el.datasetIndex] ?? {};
                    this.props.onElementClick({ label, dataset, index: el.index });
                }
            },
            ...options,
        };

        switch (chartType) {
            case "line":
                return {
                    type: "line",
                    data: { labels: data.labels, datasets: datasets.map(ds => ({ tension: 0.35, fill: true, ...ds })) },
                    options: {
                        ...baseOptions,
                        scales: {
                            x: { grid: { display: false } },
                            y: { beginAtZero: true, grid: { color: "#f0f0f0" } },
                        },
                    },
                };

            case "bar":
                return {
                    type: "bar",
                    data: { labels: data.labels, datasets },
                    options: {
                        ...baseOptions,
                        scales: {
                            x: { grid: { display: false } },
                            y: { beginAtZero: true, grid: { color: "#f0f0f0" } },
                        },
                    },
                };

            case "stacked":
                return {
                    type: "bar",
                    data: {
                        labels: data.labels,
                        datasets: datasets.map(ds => ({ ...ds, stack: "stack" })),
                    },
                    options: {
                        ...baseOptions,
                        scales: {
                            x: { stacked: true, grid: { display: false } },
                            y: { stacked: true, beginAtZero: true, grid: { color: "#f0f0f0" } },
                        },
                    },
                };

            case "horizontalBar":
                return {
                    type: "bar",
                    data: { labels: data.labels, datasets },
                    options: {
                        ...baseOptions,
                        indexAxis: "y",
                        scales: {
                            x: { beginAtZero: true, grid: { color: "#f0f0f0" } },
                            y: { grid: { display: false } },
                        },
                    },
                };

            case "doughnut":
            case "pie":
                return {
                    type: chartType === "pie" ? "pie" : "doughnut",
                    data: {
                        labels: data.labels,
                        datasets: [{
                            data: datasets[0]?.data || [],
                            backgroundColor: COLORS.map(c => c + "CC"),
                            borderColor: "#fff",
                            borderWidth: 2,
                        }],
                    },
                    options: {
                        ...baseOptions,
                        cutout: chartType === "doughnut" ? "62%" : 0,
                        plugins: {
                            ...baseOptions.plugins,
                            legend: {
                                display: true,
                                position: "right",
                                labels: { boxWidth: 12, font: { size: 11 } },
                            },
                        },
                    },
                };

            default:
                return {
                    type: "bar",
                    data: { labels: data.labels, datasets },
                    options: baseOptions,
                };
        }
    }

    onExportChart() {
        if (!this._chart) return;
        const url = this.canvasRef.el.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url;
        a.download = `${this.props.exportFilename}.png`;
        a.click();
    }
}