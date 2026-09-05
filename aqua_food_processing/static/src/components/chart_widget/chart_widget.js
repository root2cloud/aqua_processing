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
    useState,
} from "@odoo/owl";

export class ChartWidget extends Component {
    static template = "aqua_food_processing.ChartWidget";

    static props = {
        chartType:      { type: String },
        data:           { type: Object },
        options:        { type: Object,  optional: true },
        height:         { type: Number,  optional: true },
        // When true, the canvas wrapper stretches to fill whatever height
        // its parent ends up with (via CSS flex:1) instead of a fixed px
        // height. Use this whenever the card sits in a CSS grid row next to
        // a taller neighbour - a fixed height there just leaves dead white
        // space between the chart and the bottom of the (stretched) card.
        // Requires an ancestor that actually establishes a height for the
        // flex chain to fill (e.g. a grid row with equal-height stretch);
        // `height` is still used as a min-height fallback so the chart
        // never collapses to 0 before that ancestor has a size.
        fillHeight:     { type: Boolean, optional: true },
        isLoading:      { type: Boolean, optional: true },
        onElementClick: { type: Function, optional: true },
        // Title shown in the fullscreen lightbox header when the expand
        // button is used - purely cosmetic, charts still render fine
        // without one.
        title:          { type: String, optional: true },
    };

    // Owl only reads defaults from `static defaultProps`, never from a
    // `default:` key inside `static props` - without this,
    // this.props.options is undefined whenever a panel doesn't pass
    // `options` explicitly, and `...(options.plugins || {})` below throws.
    static defaultProps = {
        options:        {},
        height:         260,
        fillHeight:     false,
        isLoading:      false,
        onElementClick: () => {},
        title:          "",
    };

    setup() {
        this.canvasRef = useRef("chartCanvas");
        this.expandedCanvasRef = useRef("expandedChartCanvas");
        this._chart = null;
        this._expandedChart = null;
        // Every chart gets its own expand/fullscreen toggle (see the
        // aqua-chart-expand-btn in the template) instead of relying on the
        // parent dashboard to track per-chart state - that would mean
        // wiring a new useState flag into AquaDashboard for every single
        // chart panel on the page.
        this.state = useState({ expanded: false });

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
            if (this.state.expanded) {
                setTimeout(() => this._updateExpandedChart(), 0);
            }
        });

        onWillUnmount(() => {
            this._destroyChart();
            this._destroyExpandedChart();
        });
    }

    onExpandClick() {
        this.state.expanded = true;
        // The lightbox canvas only exists in the DOM once t-if="state.expanded"
        // renders it, so the Chart.js instance for it has to be created
        // *after* that render, not synchronously here.
        setTimeout(() => this._initExpandedChart(), 0);
    }

    onCloseExpanded() {
        this.state.expanded = false;
        this._destroyExpandedChart();
    }

    _initExpandedChart() {
        const canvas = this.expandedCanvasRef.el;
        if (!canvas || !window.Chart) return;
        this._destroyExpandedChart();
        const config = this._getChartJsConfig();
        if (config) {
            this._expandedChart = new window.Chart(canvas, config);
        }
    }

    _updateExpandedChart() {
        if (!this._expandedChart) {
            this._initExpandedChart();
            return;
        }
        const config = this._getChartJsConfig();
        if (!config) return;
        this._expandedChart.data = config.data;
        this._expandedChart.options = config.options;
        this._expandedChart.update();
    }

    _destroyExpandedChart() {
        if (this._expandedChart) {
            this._expandedChart.destroy();
            this._expandedChart = null;
        }
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

    /**
     * Soft drop-shadow ("glow") behind the line stroke — Chart.js has no
     * built-in option for this, so a tiny chart-scoped plugin sets the
     * canvas 2D shadow properties right before Chart.js strokes the line
     * dataset, then restores them straight after. This is what gives the
     * line a bit of depth/lift off the page instead of a flat, plain
     * stroke, similar to the softly-glowing lines in the reference mockups.
     */
    _lineGlowPlugin() {
        return {
            id: "aquaLineGlow",
            beforeDatasetDraw: (chart, args) => {
                const meta = chart.getDatasetMeta(args.index);
                const color = (meta.dataset && meta.dataset.options && meta.dataset.options.borderColor) || "#2C7A7B";
                const ctx = chart.ctx;
                ctx.save();
                ctx.shadowColor = color + "4D"; // ~30% opacity glow
                ctx.shadowBlur = 10;
                ctx.shadowOffsetY = 4;
            },
            afterDatasetDraw: (chart) => {
                chart.ctx.restore();
            },
        };
    }

    /**
     * Vertical dashed "crosshair" plugin for line charts — a thin dashed
     * guide from the hovered point straight down to the x-axis, exactly
     * like the reference dashboard mockups. Chart.js has no built-in
     * crosshair, so this is a small chart-scoped plugin (only attached to
     * `type: "line"` configs below) that reads the currently-active
     * tooltip point on every redraw and draws the guide itself — nothing
     * shows when nothing is hovered, since `_active` is empty then.
     */
    _crosshairPlugin() {
        return {
            id: "aquaCrosshair",
            afterDatasetsDraw: (chart) => {
                const active = chart.tooltip && chart.tooltip._active;
                if (!active || !active.length) return;
                const { ctx, chartArea } = chart;
                const x = active[0].element.x;
                ctx.save();
                ctx.beginPath();
                ctx.setLineDash([4, 4]);
                ctx.lineWidth = 1;
                ctx.strokeStyle = "#CBD5E0";
                ctx.moveTo(x, chartArea.top);
                ctx.lineTo(x, chartArea.bottom);
                ctx.stroke();
                ctx.restore();
            },
        };
    }

    /**
     * Active-tick "bubble" plugin — instead of (or in addition to) the
     * dashed crosshair line, this draws a small dark rounded pill/bubble
     * directly over the x-axis label of whichever point is currently
     * hovered, with the label text re-drawn in white on top - matching the
     * reference mockup where the active day number ("03") sits inside a
     * solid dark circle instead of the default plain axis text. Nothing is
     * drawn when no point is active, since `_active` is empty then.
     */
    _activeTickBubblePlugin() {
        return {
            id: "aquaActiveTickBubble",
            afterDatasetsDraw: (chart) => {
                const active = chart.tooltip && chart.tooltip._active;
                if (!active || !active.length) return;

                const xScale = chart.scales && chart.scales.x;
                if (!xScale || typeof xScale.getPixelForTick !== "function") return;

                const index = active[0].index;
                const label = chart.data.labels && chart.data.labels[index];
                if (label === undefined || label === null) return;

                const x = xScale.getPixelForTick(index);
                if (typeof x !== "number" || Number.isNaN(x)) return;

                const text = String(label);
                const tickFontSize = (xScale.options.ticks.font && xScale.options.ticks.font.size) || 12;
                const fontFamily = (xScale.options.ticks.font && xScale.options.ticks.font.family) ||
                    "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

                const ctx = chart.ctx;
                ctx.save();
                ctx.font = `600 ${tickFontSize}px ${fontFamily}`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";

                const textWidth = ctx.measureText(text).width;
                const radius = Math.max(tickFontSize / 2 + 7, 15);
                const bubbleWidth = Math.max(textWidth + 18, radius * 2);
                const centerY = xScale.top + (xScale.options.ticks.padding || 8) + radius;

                const rectX = x - bubbleWidth / 2;
                const rectY = centerY - radius;
                const rectH = radius * 2;

                // Painting a plain white rect first blanks out the default
                // tick label Chart.js already drew for this index, so the
                // bubble reads as a clean replacement rather than double
                // text bleeding through a see-through fill.
                ctx.fillStyle = "#fff";
                ctx.fillRect(rectX - 2, rectY - 2, bubbleWidth + 4, rectH + 4);

                // Rounded pill (falls back to a plain circle when the text
                // is short enough that bubbleWidth === radius*2). Fill is
                // a light, mostly see-through tint with just a thin border
                // so it reads as a soft transparent bubble, not a solid
                // block - dark text on top keeps it legible.
                ctx.beginPath();
                ctx.moveTo(rectX + radius, rectY);
                ctx.arcTo(rectX + bubbleWidth, rectY, rectX + bubbleWidth, rectY + rectH, radius);
                ctx.arcTo(rectX + bubbleWidth, rectY + rectH, rectX, rectY + rectH, radius);
                ctx.arcTo(rectX, rectY + rectH, rectX, rectY, radius);
                ctx.arcTo(rectX, rectY, rectX + bubbleWidth, rectY, radius);
                ctx.closePath();
                ctx.fillStyle = "rgba(113, 128, 150, 0.18)";
                ctx.fill();
                ctx.lineWidth = 1.25;
                ctx.strokeStyle = "rgba(113, 128, 150, 0.55)";
                ctx.stroke();

                ctx.fillStyle = "#1A202C";
                ctx.fillText(text, x, centerY + 1);
                ctx.restore();
            },
        };
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
                // exactly the sharp-cornered look we don't want). Tension pushed
                // up from 0.6 to 0.78 - the previous value still let real data
                // (a single sharp receiving spike, a lone spend spike, etc.) come
                // through as a narrow pointed hill; this rounds every crest/trough
                // into a soft, continuous dome/basin instead, which is the biggest
                // visible difference from the reference mockups' wave shape. Points
                // stay invisible until hovered, so the curve itself carries the shape.
                const lineDatasets = datasets.map((ds, i) => ({
                    tension: 0.78,
                    fill: true,
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: ds.borderColor || COLORS[i % COLORS.length],
                    pointHoverBorderWidth: 2,
                    pointHoverBorderColor: "#fff",
                    ...ds,
                }));
                // The reference mockups never let the wave get near the top of
                // the chart - the tallest peak still sits well under the axis
                // ceiling, which is what makes the whole thing read as "floating"
                // in open space instead of a shape cropped tight to its own box.
                // Chart.js's default auto-max hugs the data (only ~5-10% above
                // the highest point), so without this the line/fill runs almost
                // to the very top. suggestedMax at 1.6x the highest value forces
                // that same generous headroom regardless of the data's own scale.
                const allVals = lineDatasets.flatMap((ds) => (ds.data || []).filter((v) => typeof v === "number"));
                const dataMax = allVals.length ? Math.max(...allVals) : 0;
                const suggestedMax = dataMax > 0 ? dataMax * 1.6 : undefined;
                return {
                    type: "line",
                    data: { labels: data.labels, datasets: lineDatasets },
                    options: {
                        ...baseOptions,
                        layout: { padding: { top: 12, bottom: 4 } },
                        interaction: { mode: "index", intersect: false },
                        scales: {
                            x: { grid: { display: false } },
                            y: {
                                beginAtZero: true,
                                suggestedMax,
                                grid: { color: "#f0f0f0" },
                                ticks: { padding: 8 },
                            },
                        },
                    },
                    plugins: [this._lineGlowPlugin(), this._crosshairPlugin(), this._activeTickBubblePlugin()],
                };
            }

            case "bar":
                return {
                    type: "bar",
                    data: { labels: data.labels, datasets },
                    options: {
                        ...baseOptions,
                        interaction: { mode: "index", intersect: false },
                        scales: {
                            x: { grid: { display: false } },
                            y: { beginAtZero: true, grid: { color: "#f0f0f0" } },
                        },
                    },
                    plugins: [this._activeTickBubblePlugin()],
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
                        interaction: { mode: "index", intersect: false },
                        scales: {
                            x: { stacked: true, grid: { display: false } },
                            y: { stacked: true, beginAtZero: true, grid: { color: "#f0f0f0" } },
                        },
                    },
                    plugins: [this._activeTickBubblePlugin()],
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
}