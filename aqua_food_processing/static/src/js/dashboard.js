/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, useState } from "@odoo/owl";

const PALETTE = ["#2C7A7B", "#3182CE", "#D69E2E", "#C53030", "#805AD5", "#38A169", "#DD6B20", "#718096"];

class AquaDashboard extends Component {
    static template = "aqua_food_processing.DashboardMain";

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            isLoading: true,
            total_receipts: 0,
            accepted_receipts: 0,
            qc_pass_rate: 0,
            on_time_dispatch_rate: 0,
            cold_room_utilization: [],
            receipts_by_species: [],
            qc_breakdown: [],
            shipment_breakdown: [],
            receipt_trend: [],
            yield_trend: [],
        });
        onMounted(() => this.loadData());
    }

    async loadData() {
        this.state.isLoading = true;
        const ids = await this.orm.create("aqua.dashboard", [{}]);
        const data = await this.orm.call("aqua.dashboard", "get_dashboard_data", [ids]);
        Object.assign(this.state, data);
        this.state.isLoading = false;
    }

    // ---- helpers used by the template to render CSS/SVG based charts ----

    barWidth(value, list) {
        const max = Math.max(1, ...list.map((x) => x.value));
        return Math.round((value / max) * 100);
    }

    color(index) {
        return PALETTE[index % PALETTE.length];
    }

    donutStyle(list) {
        // Build a conic-gradient string for a donut chart from [{label, value}]
        const total = list.reduce((s, x) => s + x.value, 0);
        if (!total) {
            return "background: conic-gradient(#e2e8f0 0deg 360deg);";
        }
        let acc = 0;
        const stops = list.map((item, i) => {
            const start = (acc / total) * 360;
            acc += item.value;
            const end = (acc / total) * 360;
            return `${this.color(i)} ${start}deg ${end}deg`;
        });
        return `background: conic-gradient(${stops.join(", ")});`;
    }

    sparklinePoints(list, width, height) {
        if (!list.length) return "";
        const values = list.map((x) => x.value);
        const max = Math.max(1, ...values);
        const min = Math.min(0, ...values);
        const range = max - min || 1;
        const stepX = list.length > 1 ? width / (list.length - 1) : 0;
        return list
            .map((item, i) => {
                const x = i * stepX;
                const y = height - ((item.value - min) / range) * height;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
    }
}

registry.category("actions").add("aqua_dashboard_action", AquaDashboard);