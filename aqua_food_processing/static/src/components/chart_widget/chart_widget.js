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
        this._removeTooltipEl();
    }

    _removeTooltipEl() {
        if (this._tooltipEl) {
            this._tooltipEl.remove();
            this._tooltipEl = null;
        }
    }

    /**
     * Custom HTML tooltip that matches the rest of the dashboard's visual
     * system (rounded card, soft shadow, Inter font, brand accent dot)
     * instead of Chart.js's plain default browser-style box. Built once
     * per chart and repositioned/repopulated on every 'active tooltip'
     * event, then hidden (not destroyed) on 'inactive' — recreating the
     * node on every hover is what causes the flash-to-plain-box look.
     */
    _renderCustomTooltip(tctx) {
        const { chart, tooltip } = tctx;
        const canvas = chart.canvas;
        const wrapper = canvas.parentNode;
        if (!wrapper) return;

        if (!this._tooltipEl) {
            const el = document.createElement("div");
            el.className = "aqua-chart-tooltip";
            wrapper.style.position = wrapper.style.position || "relative";
            wrapper.appendChild(el);
            this._tooltipEl = el;
        }
        const el = this._tooltipEl;

        if (tooltip.opacity === 0) {
            el.style.opacity = 0;
            return;
        }

        if (tooltip.body) {
            const titleLines = tooltip.title || [];
            const bodyLines = tooltip.body.map((b) => b.lines);

            let html = "";
            if (titleLines.length) {
                html += `<div class="aqua-chart-tooltip-title">${titleLines.join(" ")}</div>`;
            }
            bodyLines.forEach((lines, i) => {
                const dp = tooltip.labelColors[i];
                const color = (dp && dp.borderColor) || (dp && dp.backgroundColor) || "#2C7A7B";
                lines.forEach((line) => {
                    html += `<div class="aqua-chart-tooltip-row">
                        <span class="aqua-chart-tooltip-dot" style="background:${color}"></span>
                        <span class="aqua-chart-tooltip-value">${line}</span>
                    </div>`;
                });
            });
            el.innerHTML = html;
        }

        const { offsetLeft: canvasLeft, offsetTop: canvasTop } = canvas;
        el.style.opacity = 1;
        el.style.left = canvasLeft + tooltip.caretX + "px";
        el.style.top = canvasTop + tooltip.caretY + "px";
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

    /**
     * Soft top-to-bottom fade under a line chart's fill area (fully opaque
     * near the line, transparent by the bottom of the chart) instead of a
     * flat translucent block — this is what makes the reference mockups'
     * trend lines read as a smooth "wave" rather than a filled rectangle.
     * Falls back to the flat color if canvas 2D context isn't available
     * (e.g. during SSR/tests) so a chart never silently fails to render.
     */
    _makeAreaGradient(hexColor) {
        const canvas = this.canvasRef.el;
        const ctx = canvas && canvas.getContext && canvas.getContext("2d");
        if (!ctx) return hexColor + "33";
        const h = canvas.height || this.props.height || 260;
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, hexColor + "3D");
        gradient.addColorStop(1, hexColor + "01");
        return gradient;
    }

    _getChartJsConfig() {
        const { chartType, data, options } = this.props;

        const COLORS = [
            "#2C7A7B", "#3182CE", "#D69E2E", "#C53030",
            "#805AD5", "#38A169", "#DD6B20", "#718096",
        ];

        const datasets = (data.datasets || []).map((ds, i) => ({
            backgroundColor: chartType === "line"
                ? this._makeAreaGradient(ds.borderColor || COLORS[i % COLORS.length])
                : COLORS[i % COLORS.length] + "CC",
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
                    enabled: false,
                    external: (tctx) => this._renderCustomTooltip(tctx),
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
            case "line": {
                // Plain Catmull-Rom tension (NOT cubicInterpolationMode:'monotone' --
                // monotone interpolation ignores `tension` entirely and forces a
                // straight, pointed line through any local peak/valley, which is
                // exactly the sharp-cornered look we don't want). A higher tension
                // here is what gives the soft, continuously-rounded "wavy thread"
                // look of the reference mockups, even through peaks. Points stay
                // invisible until hovered, so the curve itself carries the shape.
                const lineDatasets = datasets.map((ds, i) => ({
                    tension: 0.6,
                    fill: true,
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: "#fff",
                    pointHoverBorderWidth: 2,
                    pointHoverBorderColor: ds.borderColor || COLORS[i % COLORS.length],
                    ...ds,
                }));
                return {
                    type: "line",
                    data: { labels: data.labels, datasets: lineDatasets },
                    options: {
                        ...baseOptions,
                        interaction: { mode: "index", intersect: false },
                        scales: {
                            x: { grid: { display: false } },
                            y: { beginAtZero: true, grid: { color: "#f0f0f0" }, ticks: { padding: 8 } },
                        },
                    },
                };
            }

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