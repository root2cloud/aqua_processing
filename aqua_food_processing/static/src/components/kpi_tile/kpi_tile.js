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
        switch (this.props.valueFmt) {
            case "pct":
                return `${Number(v).toFixed(1)}%`;
            case "number":
            default:
                return new Intl.NumberFormat("en-IN", {
                    maximumFractionDigits: 1,
                }).format(v);
        }
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