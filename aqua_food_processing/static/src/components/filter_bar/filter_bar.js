/** @odoo-module **/
/**
 * FilterBar — period + comparison filter for the Aqua dashboard.
 * Deliberately does NOT include a company/branch selector: this dashboard is
 * scoped to a single Aqua Processing plant, so a branch filter would be a
 * dummy control with nothing behind it. Emits 'filter-change' with the full
 * filter state whenever the person changes something.
 */
import { Component, useState } from "@odoo/owl";

export class FilterBar extends Component {
    static template = "aqua_food_processing.FilterBar";

    static props = {
        onFilterChange: { type: Function },
        onRefresh:      { type: Function },
        isLoading:      { type: Boolean, optional: true },
    };

    static defaultProps = {
        isLoading: false,
    };
    setup() {
        this.state = useState({
            period:     'ytd',   // today | week | month | quarter | ytd | custom
            compare:    'none',  // none | ly | lm | lq
            customFrom: '',
            customTo:   '',
        });
    }

    get periodOptions() {
        return [
            { value: 'today',   label: 'Today' },
            { value: 'week',    label: 'This Week' },
            { value: 'month',   label: 'This Month' },
            { value: 'quarter', label: 'This Quarter' },
            { value: 'ytd',     label: 'Year to Date' },
            { value: 'all',     label: 'All Time' },
            { value: 'custom',  label: 'Custom Range' },
        ];
    }

    get compareOptions() {
        return [
            { value: 'none', label: 'No Comparison' },
            { value: 'ly',   label: 'vs Last Year' },
            { value: 'lm',   label: 'vs Last Month' },
            { value: 'lq',   label: 'vs Last Quarter' },
        ];
    }

    _emit() {
        this.props.onFilterChange({ ...this.state });
    }

    onPeriodChange(ev) {
        this.state.period = ev.target.value;
        if (this.state.period !== 'custom') this._emit();
    }

    onCompareChange(ev) {
        this.state.compare = ev.target.value;
        this._emit();
    }

    onCustomFromChange(ev) {
        this.state.customFrom = ev.target.value;
        if (this.state.customFrom && this.state.customTo) this._emit();
    }

    onCustomToChange(ev) {
        this.state.customTo = ev.target.value;
        if (this.state.customFrom && this.state.customTo) this._emit();
    }
}