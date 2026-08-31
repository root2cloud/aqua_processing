/** @odoo-module **/
/**
 * KpiTile — reusable KPI tile.
 * Renders an icon, value, label, and an optional SVG-canvas sparkline in
 * the bottom-right corner when trend data is available.
 */
import { Component, onMounted, useRef } from "@odoo/owl";

export class KpiTile extends Component {
    static template = "aqua_food_processing.KpiTile";

    static props = {
        label:         { type: String },
        value:         { type: [Number, String] },
        valueFmt:      { type: String, optional: true },   // number | pct
        icon:          { type: String, optional: true },
        color:         { type: String, optional: true },
        sparklineData: { type: Array, optional: true },
        isLoading:     { type: Boolean, optional: true },
        onDrill:       { type: Function, optional: true },
        // Optional period-comparison delta (e.g. +12.4 meaning +12.4% vs the comparison
        // period chosen in the FilterBar). Omitted entirely -> no comparison line rendered,
        // so tiles that don't have a meaningful "vs prior period" reading (e.g. a live
        // snapshot like Stock On Hand) simply don't get one.
        changePct:     { type: Number, optional: true },
        compareLabel:  { type: String, optional: true },
    };

    // Owl only reads defaults from `static defaultProps`, never from a
    // `default:` key inside `static props` (see chart_widget.js for the
    // same gotcha) - without this, this.props.sparklineData is undefined
    // and the .length check below throws.
    static defaultProps = {
        valueFmt:      "number",
        icon:          "fa-bar-chart",
        color:         "#2C7A7B",
        sparklineData: [],
        isLoading:     false,
        onDrill:       () => {},
    };

    setup() {
        this.canvasRef = useRef("sparklineCanvas");
        onMounted(() => {
            if (this.props.sparklineData.length > 1) {
                this._drawSparkline();
            }
        });
    }

    get formattedValue() {
        const v = this.props.value;
        if (v === null || v === undefined) return "—";
        if (this.props.valueFmt === "pct") {
            return `${Number(v).toFixed(1)}%`;
        }
        return this._formatCompact(v);
    }

    // The exact, uncompacted value -- shown as a tooltip on the tile so nothing is ever
    // permanently hidden from the person reading it, even once formattedValue below has
    // compacted a large number down to "9.85 Cr".
    get exactValue() {
        const v = this.props.value;
        if (v === null || v === undefined) return "";
        if (this.props.valueFmt === "pct") return `${Number(v).toFixed(2)}%`;
        return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(v);
    }

    // Large values (purchase spend, stock value, ...) rendered in full Indian digit-grouped
    // form (e.g. "9,85,42,750") are too wide for a fixed-width KPI tile and either overflow
    // or get ellipsis-truncated mid-number, which is worse than not showing a value at all.
    // Compact to Lakh / Crore -- the units an Indian business dashboard's audience already
    // reads spend/stock numbers in -- above 1 lakh, and leave anything smaller exact.
    _formatCompact(v) {
        const num = Number(v) || 0;
        const sign = num < 0 ? "-" : "";
        const abs = Math.abs(num);
        if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
        if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
        return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(num);
    }

    get hasComparison() {
        return this.props.changePct !== undefined && this.props.changePct !== null && this.props.compareLabel;
    }

    get comparisonDirectionClass() {
        const v = this.props.changePct || 0;
        if (Math.abs(v) < 0.05) return 'aqua-comparison-note--flat';
        return v > 0 ? 'aqua-comparison-note--up' : 'aqua-comparison-note--down';
    }

    get comparisonText() {
        const v = this.props.changePct || 0;
        const arrow = Math.abs(v) < 0.05 ? '▬' : (v > 0 ? '▲' : '▼');
        return `${arrow} ${Math.abs(v).toFixed(1)}% ${this.props.compareLabel}`;
    }

    _drawSparkline() {
        const canvas = this.canvasRef.el;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const data = this.props.sparklineData;
        const w = canvas.width;
        const h = canvas.height;
        const min = Math.min(...data);
        const max = Math.max(...data);
        const range = max - min || 1;

        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        ctx.strokeStyle = this.props.color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";

        data.forEach((val, i) => {
            const x = (i / (data.length - 1)) * w;
            const y = h - ((val - min) / range) * h;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
    }

    onClick() {
        this.props.onDrill();
    }
}