/** @odoo-module **/
/**
 * AquaDatePicker — the dashboard's own calendar popover.
 *
 * Replaces the `<input type="date">` that used to sit in the two custom-range
 * pills. That input was fine as a *value holder*, but clicking it handed the
 * calendar over to the browser: Chrome/Edge draw their own panel with their
 * own square corners, their own #0b57d0 blue, their own system font and their
 * own year list. None of that follows this dashboard's tokens, none of it
 * follows dark mode, and none of it can be restyled from CSS — the panel is
 * painted outside the page. So the calendar itself is drawn here instead,
 * from the same tokens (--blue / --blue-tint / --line / --card / --radius-sm)
 * and the same motion curves as the filter dropdowns next to it.
 *
 * The public contract is unchanged: `value` in and `onChange` out are both
 * plain ISO `YYYY-MM-DD` strings, exactly what the old input emitted, so
 * dashboard.js's filter payload and the Python side see no difference.
 */
import { Component, useState, useRef, useExternalListener } from "@odoo/owl";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];
// Su-first, matching the week layout people were already seeing here.
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
// How many years one page of the year grid shows (4 columns x 3 rows).
const YEAR_PAGE = 12;

function pad2(n) {
    return String(n).padStart(2, "0");
}

/** Local-time ISO. Deliberately NOT toISOString(), which converts to UTC and
 *  can hand back the previous day for anyone east of Greenwich — this plant
 *  runs at UTC+5:30, so that bug would fire for every user, every day. */
function toISO(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Parses `YYYY-MM-DD` into a local midnight Date, or null if it isn't one.
 *  Rejects real-looking-but-invalid input (2026-02-31) by round-tripping the
 *  parts back out of the constructed Date. */
function parseISO(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) {
        return null;
    }
    const year = +match[1];
    const month = +match[2] - 1;
    const day = +match[3];
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
        return null;
    }
    return date;
}

function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export class AquaDatePicker extends Component {
    static template = "aqua_food_processing.AquaDatePicker";

    static props = {
        // ISO YYYY-MM-DD, or "" while nothing is picked yet.
        value:       { type: String, optional: true },
        // Called with the new ISO string ("" when cleared).
        onChange:    { type: Function },
        placeholder: { type: String, optional: true },
        // Text for the dashboard's own [data-aqua-tooltip] bubble.
        tooltip:     { type: String, optional: true },
        ariaLabel:   { type: String, optional: true },
        // Bounds, both ISO. Days outside them render disabled — this is how
        // the two range pills stop anyone picking an end before their start.
        min:         { type: String, optional: true },
        max:         { type: String, optional: true },
        // The full selected range, so both pills can shade the days between
        // them and it reads as one range rather than two lone dates.
        rangeFrom:   { type: String, optional: true },
        rangeTo:     { type: String, optional: true },
        // Hangs the panel off the pill's right edge instead of its left, for
        // the pill that sits closest to the right side of the topbar.
        alignEnd:    { type: Boolean, optional: true },
    };

    static defaultProps = {
        value: "",
        placeholder: "Select date",
        tooltip: "",
        ariaLabel: "Date",
        min: "",
        max: "",
        rangeFrom: "",
        rangeTo: "",
        alignEnd: false,
    };

    setup() {
        this.months = MONTHS_SHORT;
        this.weekdays = WEEKDAYS;
        this.today = startOfToday();

        const selected = parseISO(this.props.value) || this.today;
        this.state = useState({
            open: false,
            // 'days' -> 'months' -> 'years', drilled into by clicking the
            // header label, and unwound by picking a cell.
            view: "days",
            year: selected.getFullYear(),
            month: selected.getMonth(),
            // Top-left year of the currently shown year page.
            yearPageStart: selected.getFullYear() - (selected.getFullYear() % YEAR_PAGE),
        });

        this.rootRef = useRef("root");

        // Click anywhere outside closes — same convention as the filter
        // dropdowns. The click that *opens* the panel starts inside the root,
        // so it doesn't immediately close it again.
        useExternalListener(window, "click", (ev) => {
            if (!this.state.open) {
                return;
            }
            if (this.rootRef.el && !this.rootRef.el.contains(ev.target)) {
                this.close();
            }
        });

        useExternalListener(window, "keydown", (ev) => {
            if (this.state.open && ev.key === "Escape") {
                ev.stopPropagation();
                this.close();
            }
        });
    }

    // ---------------------------------------------------------------- state

    get selectedDate() {
        return parseISO(this.props.value);
    }

    get minDate() {
        return parseISO(this.props.min);
    }

    get maxDate() {
        return parseISO(this.props.max);
    }

    /** What the pill shows when closed: "8 Sep 2026", or the placeholder. */
    get displayLabel() {
        const date = this.selectedDate;
        if (!date) {
            return this.props.placeholder;
        }
        return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
    }

    get hasValue() {
        return !!this.selectedDate;
    }

    /** Header text, which depends on how deep into the panel we've drilled. */
    get headerLabel() {
        if (this.state.view === "years") {
            return `${this.state.yearPageStart} – ${this.state.yearPageStart + YEAR_PAGE - 1}`;
        }
        if (this.state.view === "months") {
            return String(this.state.year);
        }
        return `${MONTHS_LONG[this.state.month]} ${this.state.year}`;
    }

    get yearPage() {
        const years = [];
        for (let i = 0; i < YEAR_PAGE; i++) {
            years.push(this.state.yearPageStart + i);
        }
        return years;
    }

    /**
     * Six fixed rows of seven days, leading/trailing cells filled from the
     * neighbouring months. Fixed at six so the panel never changes height
     * between months — a jumping popover is the kind of thing people notice
     * without being able to say why it feels cheap.
     */
    get weeks() {
        const { year, month } = this.state;
        const selected = this.selectedDate;
        const min = this.minDate;
        const max = this.maxDate;
        const rangeFrom = parseISO(this.props.rangeFrom);
        const rangeTo = parseISO(this.props.rangeTo);

        const firstOfMonth = new Date(year, month, 1);
        const cursor = new Date(year, month, 1 - firstOfMonth.getDay());

        const weeks = [];
        for (let w = 0; w < 6; w++) {
            const days = [];
            for (let d = 0; d < 7; d++) {
                const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
                const time = date.getTime();
                const inRange = !!(rangeFrom && rangeTo &&
                                   time > rangeFrom.getTime() && time < rangeTo.getTime());
                days.push({
                    iso: toISO(date),
                    day: date.getDate(),
                    outside: date.getMonth() !== month,
                    today: time === this.today.getTime(),
                    selected: !!selected && time === selected.getTime(),
                    inRange: inRange,
                    disabled: (!!min && time < min.getTime()) || (!!max && time > max.getTime()),
                });
                cursor.setDate(cursor.getDate() + 1);
            }
            weeks.push({ key: `w${w}`, days });
        }
        return weeks;
    }

    /** Whole months greyed out when every day in them is out of bounds. */
    isMonthDisabled(monthIndex) {
        const min = this.minDate;
        const max = this.maxDate;
        const lastDay = new Date(this.state.year, monthIndex + 1, 0);
        const firstDay = new Date(this.state.year, monthIndex, 1);
        return (!!min && lastDay.getTime() < min.getTime()) ||
               (!!max && firstDay.getTime() > max.getTime());
    }

    isYearDisabled(year) {
        const min = this.minDate;
        const max = this.maxDate;
        return (!!min && year < min.getFullYear()) || (!!max && year > max.getFullYear());
    }

    isTodayDisabled() {
        const min = this.minDate;
        const max = this.maxDate;
        const time = this.today.getTime();
        return (!!min && time < min.getTime()) || (!!max && time > max.getTime());
    }

    // ------------------------------------------------------------- handlers

    /** Space/Enter open the pill, matching what a real <button> would do —
     *  the trigger is a div so it can carry the pill styling. */
    onTriggerKeydown(ev) {
        if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            this.toggle();
        }
    }

    toggle() {
        if (this.state.open) {
            this.close();
            return;
        }
        // Always reopen on the selected date (or today), never on wherever
        // the person happened to have browsed to last time.
        const anchor = this.selectedDate || this.today;
        this.state.year = anchor.getFullYear();
        this.state.month = anchor.getMonth();
        this.state.yearPageStart = anchor.getFullYear() - (anchor.getFullYear() % YEAR_PAGE);
        this.state.view = "days";
        this.state.open = true;
    }

    close() {
        this.state.open = false;
        this.state.view = "days";
    }

    /** Header label drills one level out: days -> months -> years. */
    onHeaderClick() {
        if (this.state.view === "days") {
            this.state.view = "months";
        } else if (this.state.view === "months") {
            this.state.yearPageStart = this.state.year - (this.state.year % YEAR_PAGE);
            this.state.view = "years";
        } else {
            this.state.view = "months";
        }
    }

    /** The chevrons step by whatever unit the current view is made of. */
    step(direction) {
        if (this.state.view === "years") {
            this.state.yearPageStart += direction * YEAR_PAGE;
            return;
        }
        if (this.state.view === "months") {
            this.state.year += direction;
            return;
        }
        const shifted = new Date(this.state.year, this.state.month + direction, 1);
        this.state.year = shifted.getFullYear();
        this.state.month = shifted.getMonth();
    }

    selectDay(day) {
        if (day.disabled) {
            return;
        }
        this.props.onChange(day.iso);
        this.close();
    }

    selectMonth(monthIndex) {
        if (this.isMonthDisabled(monthIndex)) {
            return;
        }
        this.state.month = monthIndex;
        this.state.view = "days";
    }

    selectYear(year) {
        if (this.isYearDisabled(year)) {
            return;
        }
        this.state.year = year;
        this.state.view = "months";
    }

    onTodayClick() {
        if (this.isTodayDisabled()) {
            return;
        }
        this.props.onChange(toISO(this.today));
        this.close();
    }

    onClearClick() {
        this.props.onChange("");
        this.close();
    }
}