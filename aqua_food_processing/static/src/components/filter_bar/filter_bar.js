/** @odoo-module **/
/**
 * FilterBar — period + comparison filter for the Aqua dashboard.
 * Deliberately does NOT include a company/branch selector: this dashboard is
 * scoped to a single Aqua Processing plant, so a branch filter would be a
 * dummy control with nothing behind it. Emits 'filter-change' with the full
 * filter state whenever the person changes something.
 */
import { Component, useState, useExternalListener } from "@odoo/owl";

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
            openMenu:   null,    // null | 'period' | 'compare'
        });
        // Any click outside an open dropdown panel closes it — this is what
        // makes the custom menu behave like the rest of the app's popovers
        // instead of a native <select>.
        useExternalListener(window, "click", (ev) => {
            if (!this.state.openMenu) return;
            if (!ev.target.closest(".aqua-dropdown")) {
                this.state.openMenu = null;
            }
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

    toggleMenu(name) {
        this.state.openMenu = this.state.openMenu === name ? null : name;
    }

    selectPeriod(value) {
        this.state.period = value;
        this.state.openMenu = value === 'custom' ? 'period' : null;
        if (value !== 'custom') this._emit();
    }

    selectCompare(value) {
        this.state.compare = value;
        this.state.openMenu = null;
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