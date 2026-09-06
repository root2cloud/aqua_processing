/** @odoo-module **/
/**
 * FilterBar — period + comparison filter for the Aqua dashboard.
 * Deliberately does NOT include a company/branch selector: this dashboard is
 * scoped to a single Aqua Processing plant, so a branch filter would be a
 * dummy control with nothing behind it. Emits 'filter-change' with the full
 * filter state whenever the person changes something.
 */
import { Component, useState, useExternalListener, useRef, onPatched } from "@odoo/owl";

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

        // Sliding highlight inside each open dropdown panel — same bouncy
        // glide as the tab bar, just moving vertically between rows
        // instead of horizontally between tabs. Each panel only exists in
        // the DOM while it's open (t-if), so there's nothing to measure
        // until it renders; onPatched re-measures after every render,
        // which covers "just opened" and "hovering a different row".
        this.periodPanelRef = useRef("periodPanel");
        this.comparePanelRef = useRef("comparePanel");
        this.gliders = useState({
            period:  { top: 0, height: 0, ready: false },
            compare: { top: 0, height: 0, ready: false },
        });
        onPatched(() => this._syncGliders());
    }

    // Runs after every render. Two jobs:
    //  - a panel that just opened has no glider position yet -> snap it to
    //    the active row (first paint, no need to animate that one)
    //  - a panel that just closed still has ready=true from before -> drop
    //    it so the next time it opens it starts fresh instead of gliding
    //    in from a stale position
    _syncGliders() {
        this._syncOneGlider("period", this.periodPanelRef);
        this._syncOneGlider("compare", this.comparePanelRef);
    }

    _syncOneGlider(menuName, panelRef) {
        const glider = this.gliders[menuName];
        if (this.state.openMenu !== menuName) {
            if (glider.ready) glider.ready = false;
            return;
        }
        if (glider.ready) return; // already positioned; hover/leave handlers take it from here
        const panel = panelRef.el;
        if (!panel) return;
        const activeRow = panel.querySelector(".aqua-dropdown-option--active") || panel.querySelector(".aqua-dropdown-option");
        if (activeRow) this._placeGlider(menuName, panelRef, activeRow);
    }

    // Moves a panel's glider to sit behind a given row element.
    _placeGlider(menuName, panelRef, rowEl) {
        const panel = panelRef.el;
        if (!panel || !rowEl) return;
        const panelRect = panel.getBoundingClientRect();
        const rowRect = rowEl.getBoundingClientRect();
        this.gliders[menuName].top = rowRect.top - panelRect.top;
        this.gliders[menuName].height = rowRect.height;
        this.gliders[menuName].ready = true;
    }

    // Hovering a row glides the highlight to it (mirrors the tab bar's
    // glide between tabs).
    onOptionHover(menuName, ev) {
        this._placeGlider(menuName, menuName === "period" ? this.periodPanelRef : this.comparePanelRef, ev.currentTarget);
    }

    // Leaving the panel glides the highlight back to whichever option is
    // actually selected, rather than leaving it stuck on the last-hovered
    // row.
    onPanelMouseLeave(menuName) {
        const panelRef = menuName === "period" ? this.periodPanelRef : this.comparePanelRef;
        const panel = panelRef.el;
        if (!panel) return;
        const activeRow = panel.querySelector(".aqua-dropdown-option--active");
        if (activeRow) this._placeGlider(menuName, panelRef, activeRow);
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