/** @odoo-module **/
/**
 * DrillPanel — click-through from a KPI tile or chart element to the actual
 * Odoo records behind that number, with an "open in Odoo" per-row action.
 *
 * Usage in a dashboard component:
 *   <DrillPanel
 *       isOpen="state.drill.isOpen"
 *       title="state.drill.title"
 *       model="state.drill.model"
 *       records="state.drill.records"
 *       columns="state.drill.columns"
 *       isLoading="state.drill.loading"
 *       onClose="() => this.closeDrill()"
 *   />
 */
import { Component } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class DrillPanel extends Component {
    static template = "aqua_food_processing.DrillPanel";

    static props = {
        isOpen:     { type: Boolean },
        title:      { type: String },
        model:      { type: [String, Boolean], optional: true },
        records:    { type: Array, optional: true },
        columns:    { type: Array, optional: true },
        // columns: [{ field, label, fmt }]  fmt: number|pct|date|status|string
        isLoading:  { type: Boolean, optional: true },
        onClose:    { type: Function },
    };

    // See kpi_tile.js / chart_widget.js - `default:` inside static props is
    // inert in Owl; real defaults must go in static defaultProps.
    static defaultProps = {
        model:      false,
        records:    [],
        columns:    [],
        isLoading:  false,
    };

    setup() {
        this.action = useService("action");
    }

    _formatCell(value, fmt) {
        if (value === null || value === undefined || value === '') return '—';
        switch (fmt) {
            case 'number':
                return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
            case 'pct':
                return `${Number(value).toFixed(1)}%`;
            case 'date':
                return String(value).slice(0, 10);
            default:
                return String(value);
        }
    }

    openFormView(rec) {
        if (!this.props.model || !rec.id) return;
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: this.props.model,
            res_id: rec.id,
            views: [[false, 'form']],
            target: 'current',
        });
    }

    onBackdropClick(ev) {
        if (ev.target === ev.currentTarget) {
            this.props.onClose();
        }
    }

    exportToCSV() {
        if (!this.props.records.length || !this.props.columns.length) return;
        const headers = this.props.columns.map(c => c.label).join(',');
        const rows = this.props.records.map(rec =>
            this.props.columns.map(c => `"${String(rec[c.field] ?? '').replace(/"/g, '""')}"`).join(',')
        );
        const csv = [headers, ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aqua_drill_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }
}