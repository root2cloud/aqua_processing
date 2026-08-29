/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, useState } from "@odoo/owl";

import { KpiTile } from "../components/kpi_tile/kpi_tile";
import { ChartWidget } from "../components/chart_widget/chart_widget";
import { DrillPanel } from "../components/drill_panel/drill_panel";

class AquaDashboard extends Component {
    static template = "aqua_food_processing.DashboardMain";
    static components = { KpiTile, ChartWidget, DrillPanel };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.state = useState({
            isLoading: true,
            activeTab: 'overview',
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
            yield_trend: [],
            receipt_status_breakdown: [],
            spend_by_vendor: [],
            weight_by_vendor: [],
            ordered_vs_received: [],
            recent_receipts_table: [],

            total_processing_orders: 0,
            total_input_qty: 0,
            avg_yield_pct: 0,
            avg_byproduct_yield_pct: 0,
            active_blast_freeze_count: 0,
            processing_status_breakdown: [],
            input_qty_by_species: [],
            byproduct_yield_trend: [],
            blast_freeze_status: [],
            recent_processing_table: [],

            qc_total: 0,
            qc_fail_count: 0,
            qc_todo_count: 0,
            qc_hold_count: 0,
            avg_histamine_ppm: 0,
            avg_sensory_score: 0,
            qc_stage_breakdown: [],
            intake_decision_breakdown: [],
            residue_screening: { labels: [], antibiotic: [], sulphite: [] },
            qc_trend: [],
            rejected_qty_by_species: [],
            recent_qc_table: [],

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
    }

    // ---- Tabs: Overview / Procurement / Processing / Quality Control ----
    setActiveTab(tabName) {
        this.state.activeTab = tabName;
    }

    isTabActive(tabName) {
        return this.state.activeTab === tabName;
    }

    async loadData() {
        this.state.isLoading = true;
        this._dashboardIds = await this.orm.create("aqua.dashboard", [{}]);
        const data = await this.orm.call("aqua.dashboard", "get_dashboard_data", [this._dashboardIds]);
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

    get yieldChartData() {
        const rows = this.state.yield_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "Yield %", data: rows.map((x) => x.value), borderColor: "#805AD5" }],
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

    get byproductYieldChartData() {
        const rows = this.state.byproduct_yield_trend;
        return {
            labels: rows.map((x) => x.label),
            datasets: [{ label: "By-product Yield %", data: rows.map((x) => x.value), borderColor: "#D69E2E" }],
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

    onDrillTotalPurchaseSpend() {
        this._openDrill('total_purchase_spend', null, 'Confirmed Purchase Orders');
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

    onDrillQcTotal() {
        this._openDrill('qc_total', null, 'All Quality Checks');
    }

    onDrillQcFail() {
        this._openDrill('qc_fail_count', null, 'Failed Quality Checks');
    }

    onDrillQcHold() {
        this._openDrill('qc_hold_count', null, 'On-Hold Quality Checks');
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
        this._openDrill('receipt_trend', ctx.label, `Catch Receipts — week ${ctx.label}`);
    }

    onYieldChartClick(ctx) {
        this._openDrill('yield_trend', ctx.label, `Processing Order — ${ctx.label}`);
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

    onByproductYieldChartClick(ctx) {
        this._openDrill('byproduct_yield_trend', ctx.label, `Processing Order — ${ctx.label}`);
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
        this._openDrill('qc_trend', ctx.label, `Quality Checks — week ${ctx.label}`);
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