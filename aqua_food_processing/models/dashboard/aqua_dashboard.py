from datetime import datetime, time, timedelta

from dateutil.relativedelta import relativedelta

from odoo import fields, models

# A quality.check only counts towards the Aqua dashboard if it's actually part of the Aqua
# lifecycle (raised against a Catch Receipt's picking, a Processing Order, or a Pack Order).
# Without this filter the KPIs would include every quality.check in the database, including
# ones from completely unrelated stock operations.
AQUA_QC_DOMAIN = [
    '|', '|',
    ('aqua_catch_receipt_id', '!=', False),
    ('aqua_processing_order_id', '!=', False),
    ('aqua_pack_order_id', '!=', False),
]

QC_STATE_LABELS = {'none': 'To Do', 'pass': 'Pass', 'fail': 'Fail'}

# Display name for each FilterBar period, used in the trend chart titles (e.g. "This
# Quarter Receipt Trend") -- deliberately the period's own name, not the bucket size
# used to group its data points (see _trend_granularity).
TREND_PERIOD_LABELS = {
    'today': 'Today',
    'week': 'This Week',
    'month': 'This Month',
    'quarter': 'This Quarter',
    'ytd': 'YTD',
    'all': 'All Time',
    'custom': 'Custom Range',
}
QC_LABEL_TO_STATE = {v: k for k, v in QC_STATE_LABELS.items()}

SHIPMENT_STATE_LABELS = {'booked': 'Booked', 'stuffed': 'Stuffed', 'dispatched': 'Dispatched', 'delivered': 'Delivered'}
SHIPMENT_LABEL_TO_STATE = {v: k for k, v in SHIPMENT_STATE_LABELS.items()}

# aqua.catch.receipt.state only ever has these three values (see aqua_catch_receipt.py). Any
# stored 'accepted' you might see on old rows is leftover from before this field was renamed --
# 'completed' is the current equivalent.
RECEIPT_STATE_LABELS = {'open': 'Open', 'completed': 'Completed', 'cancelled': 'Cancelled'}
RECEIPT_LABEL_TO_STATE = {v: k for k, v in RECEIPT_STATE_LABELS.items()}

MO_STATE_LABELS = {
    'draft': 'Draft', 'confirmed': 'Confirmed', 'progress': 'In Progress',
    'to_close': 'To Close', 'done': 'Done', 'cancel': 'Cancelled',
}
MO_LABEL_TO_STATE = {v: k for k, v in MO_STATE_LABELS.items()}

BLAST_STATE_LABELS = {'scheduled': 'Scheduled', 'running': 'Running', 'completed': 'Completed'}
BLAST_LABEL_TO_STATE = {v: k for k, v in BLAST_STATE_LABELS.items()}

QC_STAGE_LABELS = {
    'raw_material': 'IQC — Incoming (Receiving)',
    'in_process': 'IPQC — In-Process (Manufacturing)',
    'final': 'Final QC (Pre-Shipment)',
}
QC_STAGE_LABEL_TO_STAGE = {v: k for k, v in QC_STAGE_LABELS.items()}
QC_STAGE_SHORT_LABELS = {'raw_material': 'IQC', 'in_process': 'IPQC', 'final': 'Final QC'}

INTAKE_DECISION_LABELS = {'accept': 'Accept', 'reject': 'Reject', 'downgrade': 'Downgrade / Conditional'}
INTAKE_DECISION_LABEL_TO_VALUE = {v: k for k, v in INTAKE_DECISION_LABELS.items()}

PICKING_STATE_LABELS = {
    'draft': 'Draft', 'waiting': 'Waiting', 'confirmed': 'Waiting', 'assigned': 'Ready',
    'done': 'Done', 'cancel': 'Cancelled',
}

RESIDUE_RESULT_LABELS = {'not_tested': 'Not Tested', 'not_detected': 'Not Detected', 'detected': 'Detected'}

COMPARE_LABELS = {'ly': 'vs Last Year', 'lm': 'vs Last Month', 'lq': 'vs Last Quarter'}


class AquaDashboard(models.TransientModel):
    _name = 'aqua.dashboard'
    _description = 'Aqua Dashboard Data Provider'

    def _production_staging_location_ids(self, company_id=None):
        """The stock.warehouse Pre-Production / Post-Production location ids (pbm_loc_id /
        sam_loc_id) -- Odoo's own manufacturing staging locations, shared by both
        _raw_material_quant_domain() (which excludes them) and the Processing tab's WIP
        figures (which show *only* them). Kept in one place so the two stay consistent.
        """
        wh_domain = [('company_id', '=', company_id)] if company_id else []
        warehouses = self.env['stock.warehouse'].search(wh_domain)
        return list(filter(None, warehouses.mapped('pbm_loc_id').ids + warehouses.mapped('sam_loc_id').ids))

    def _raw_material_quant_domain(self, company_id=None):
        """Domain for stock.quant rows that represent *purchased raw material actually on
        hand* -- i.e. what a manager means by "today's stock" on the Procurement tab.

        Deliberately excludes each warehouse's Pre-Production / Post-Production locations
        (stock.warehouse.pbm_loc_id / sam_loc_id). Those are Odoo's own standard staging
        locations, auto-created whenever a warehouse's Manufacture route is 2- or 3-step --
        they hold components already committed to a Processing Order (work-in-progress), not
        raw material sitting in the yard/cold room waiting to be used. Including them made
        "Stock On Hand" swing negative and mixed two different questions into one number.
        WIP belongs on the Processing tab, not here.
        """
        aqua_products = self.env['product.product'].search([('aqua_species_id', '!=', False)])
        domain = [('product_id', 'in', aqua_products.ids), ('location_id.usage', '=', 'internal')]
        excluded_location_ids = self._production_staging_location_ids(company_id)
        if excluded_location_ids:
            domain += [('location_id', 'not in', excluded_location_ids)]
        if company_id:
            domain += [('company_id', '=', company_id)]
        return domain

    def _wip_quant_domain(self, company_id=None):
        """The mirror image of _raw_material_quant_domain(): stock.quant rows sitting *in*
        Pre-/Post-Production right now -- raw material already committed to a Processing
        Order but not yet consumed into finished/by-product output. This is the number that
        belongs on the Processing tab, not the Procurement one.
        """
        staging_ids = self._production_staging_location_ids(company_id)
        if not staging_ids:
            return [('id', '=', 0)]
        aqua_products = self.env['product.product'].search([('aqua_species_id', '!=', False)])
        domain = [('product_id', 'in', aqua_products.ids), ('location_id', 'in', staging_ids)]
        if company_id:
            domain += [('company_id', '=', company_id)]
        return domain

    def _compute_period_range(self, period, date_from=None, date_to=None):
        """(start_date, end_date) as plain dates for the FilterBar's chosen period, or
        (None, None) for 'all' / an unrecognized value -- meaning no date filtering at all,
        the dashboard's original all-time behavior."""
        today = fields.Date.context_today(self)
        if period == 'custom':
            try:
                start = fields.Date.from_string(date_from) if date_from else None
                end = fields.Date.from_string(date_to) if date_to else None
            except ValueError:
                start = end = None
            return (start, end) if (start and end) else (None, None)
        if period == 'today':
            return today, today
        if period == 'week':
            return today - timedelta(days=today.weekday()), today
        if period == 'month':
            return today.replace(day=1), today
        if period == 'quarter':
            q_start_month = ((today.month - 1) // 3) * 3 + 1
            return today.replace(month=q_start_month, day=1), today
        if period == 'ytd':
            return today.replace(month=1, day=1), today
        return None, None

    def _compute_prior_range(self, compare, start_date, end_date):
        """Shifts [start_date, end_date] back by one year / quarter / month, keeping the
        same window length, per the FilterBar's chosen comparison basis."""
        if not start_date or not end_date or compare not in ('ly', 'lq', 'lm'):
            return None, None
        shift = {'ly': relativedelta(years=1), 'lq': relativedelta(months=3), 'lm': relativedelta(months=1)}[compare]
        return start_date - shift, end_date - shift

    def _datetime_bounds(self, start_date, end_date):
        """Plain dates -> the full-day Datetime bounds needed to filter Datetime fields
        (receipt_date, date_order, control_date, create_date are all Datetime, not Date)."""
        if not start_date or not end_date:
            return None, None
        return datetime.combine(start_date, time.min), datetime.combine(end_date, time.max)

    def _trend_granularity(self, period, start_date, end_date):
        """Pick a bucket size for the trend line charts (Receipt / Purchase Spend / Avg
        Price per kg) to match the FilterBar's active period, by name rather than by
        measuring the date span: Today buckets by day, This Week by week, and This
        Month/This Quarter/Year to Date/All Time by month. A Custom range has no period
        name to key off, so it falls back to sizing itself off the actual span.
        Returns (bucket_fn, period_label) where bucket_fn(dt) -> (sort_key, display_label)
        and period_label is the FilterBar period's own name (e.g. 'This Quarter', 'YTD') --
        used as-is in the chart titles, regardless of what bucket size was picked above."""
        def day_bucket(dt):
            return dt.strftime('%Y-%m-%d'), dt.strftime('%d %b')

        def week_bucket(dt):
            monday = dt.date() - timedelta(days=dt.weekday()) if hasattr(dt, 'date') else dt - timedelta(days=dt.weekday())
            return monday.strftime('%Y-%m-%d'), 'Week of ' + monday.strftime('%d %b')

        def month_bucket(dt):
            return dt.strftime('%Y-%m'), dt.strftime('%b %Y')

        period_label = TREND_PERIOD_LABELS.get(period, 'Custom Range')

        if period == 'today':
            return day_bucket, period_label
        if period in ('week', 'quarter'):
            return week_bucket, period_label
        if period in ('month', 'ytd', 'all'):
            return month_bucket, period_label

        # 'custom' (or anything unrecognized): no fixed name to key off, so size the
        # buckets off the actual selected range instead (title still just says 'Custom Range').
        span_days = (end_date - start_date).days if (start_date and end_date) else None
        if span_days is not None and span_days <= 14:
            return day_bucket, period_label
        if span_days is not None and span_days <= 120:
            return week_bucket, period_label
        return month_bucket, period_label

    def _trend_bucket_matches(self, dt, filter_value):
        """Drill-through match for the three trend charts above: recomputes all three
        possible bucket labels for dt (day/week/month) and checks filter_value against
        each, since get_drill_records() (deliberately -- see its docstring) isn't told
        which granularity was on screen when the point was clicked."""
        if not dt or not filter_value:
            return False
        if dt.strftime('%d %b') == filter_value:
            return True
        monday = dt.date() - timedelta(days=dt.weekday()) if hasattr(dt, 'date') else dt - timedelta(days=dt.weekday())
        if 'Week of ' + monday.strftime('%d %b') == filter_value:
            return True
        return dt.strftime('%b %Y') == filter_value

    def _pass_rate(self, QC, domain):
        total = QC.search_count(domain)
        if not total:
            return 0.0
        passed = QC.search_count(domain + [('quality_state', '=', 'pass')])
        return passed / total * 100.0

    def _flow_kpis(self, dt_from, dt_to, company_id=None):
        """The handful of flow metrics used for the FilterBar's period-over-period
        comparison. Deliberately excludes point-in-time snapshots like Stock On Hand --
        comparing "stock right now" against "stock at some point last year" isn't a
        meaningful percentage, it's just two unrelated numbers. Kept separate from the main
        body of get_dashboard_data() below so it can be called a second time, unchanged,
        against the prior comparison window without duplicating logic inline.
        """
        domain = [('company_id', '=', company_id)] if company_id else []
        if dt_from:
            domain += [('receipt_date', '>=', dt_from), ('receipt_date', '<=', dt_to)]
        Receipt = self.env['aqua.catch.receipt']
        receipts = Receipt.search(domain)
        total_receipts = len(receipts)
        total_weight_received = sum(receipts.mapped('total_received'))

        po_domain = [('state', 'in', ('purchase', 'done'))]
        if company_id:
            po_domain += [('company_id', '=', company_id)]
        if dt_from:
            po_domain += [('date_order', '>=', dt_from), ('date_order', '<=', dt_to)]
        purchase_orders = self.env['purchase.order'].search(po_domain)
        total_purchase_spend = sum(purchase_orders.mapped('amount_total'))
        avg_price_per_kg = (total_purchase_spend / total_weight_received) if total_weight_received else 0.0

        qc_domain = list(AQUA_QC_DOMAIN)
        if dt_from:
            qc_domain += [('control_date', '>=', dt_from), ('control_date', '<=', dt_to)]
        QC = self.env['quality.check']
        qc_total = QC.search_count(qc_domain)
        qc_pass_rate = self._pass_rate(QC, qc_domain)
        iqc_pass_rate = self._pass_rate(QC, qc_domain + [('aqua_test_stage', '=', 'raw_material')])
        ipqc_pass_rate = self._pass_rate(QC, qc_domain + [('aqua_test_stage', '=', 'in_process')])

        mo_domain = [('catch_receipt_id', '!=', False)]
        if company_id:
            mo_domain += [('company_id', '=', company_id)]
        if dt_from:
            mo_domain += [('create_date', '>=', dt_from), ('create_date', '<=', dt_to)]
        productions = self.env['mrp.production'].search(mo_domain)
        total_processing_orders = len(productions)
        total_input_qty = sum(productions.mapped('qty_input'))

        return {
            'total_receipts': total_receipts,
            'total_weight_received': total_weight_received,
            'total_purchase_spend': total_purchase_spend,
            'avg_price_per_kg': avg_price_per_kg,
            'qc_total': qc_total,
            'qc_pass_rate': qc_pass_rate,
            'iqc_pass_rate': iqc_pass_rate,
            'ipqc_pass_rate': ipqc_pass_rate,
            'total_processing_orders': total_processing_orders,
            'total_input_qty': total_input_qty,
        }

    def get_dashboard_data(self, company_id=None, period='ytd', compare='none', date_from=None, date_to=None):
        start_date, end_date = self._compute_period_range(period, date_from, date_to)
        dt_from, dt_to = self._datetime_bounds(start_date, end_date)

        domain = [('company_id', '=', company_id)] if company_id else []
        if dt_from:
            domain += [('receipt_date', '>=', dt_from), ('receipt_date', '<=', dt_to)]

        # qc_period_domain plus the active period's date bounds -- used everywhere in this
        # method instead of the raw constant, so every QC number below respects the
        # FilterBar's Period selection. get_drill_records() further down deliberately keeps
        # using the raw qc_period_domain (full history) so a drill-through always shows every
        # matching record, not just the ones in the currently-selected window.
        qc_period_domain = list(AQUA_QC_DOMAIN)
        if dt_from:
            qc_period_domain += [('control_date', '>=', dt_from), ('control_date', '<=', dt_to)]

        Receipt = self.env['aqua.catch.receipt']
        QC = self.env['quality.check']
        Shipment = self.env['aqua.shipment']
        ColdRoom = self.env['aqua.cold.room']
        Production = self.env['mrp.production']
        Purchase = self.env['purchase.order']

        # --- KPI cards: Procurement ---
        total_receipts = Receipt.search_count(domain)
        # 'completed' is the correct current state for a fully-received receipt (see
        # RECEIPT_STATE_LABELS above -- the model has never had an 'accepted' state).
        accepted_receipts = Receipt.search_count(domain + [('state', '=', 'completed')])
        cancelled_receipts = Receipt.search_count(domain + [('state', '=', 'cancelled')])
        rejection_rate = (cancelled_receipts / total_receipts * 100.0) if total_receipts else 0.0

        receipts_for_weight = Receipt.search(domain)
        total_weight_received = sum(receipts_for_weight.mapped('total_received'))
        active_vendor_count = len(set(receipts_for_weight.mapped('vendor_id').ids))

        po_domain = [('state', 'in', ('purchase', 'done'))]
        if company_id:
            po_domain += [('company_id', '=', company_id)]
        if dt_from:
            po_domain += [('date_order', '>=', dt_from), ('date_order', '<=', dt_to)]
        purchase_orders = Purchase.search(po_domain)
        total_purchase_spend = sum(purchase_orders.mapped('amount_total'))
        avg_price_per_kg = (total_purchase_spend / total_weight_received) if total_weight_received else 0.0

        qc_total = QC.search_count(qc_period_domain)
        qc_pass = QC.search_count(qc_period_domain + [('quality_state', '=', 'pass')])
        qc_pass_rate = (qc_pass / qc_total * 100.0) if qc_total else 0.0

        shipments_dispatched = Shipment.search_count([('state', 'in', ('dispatched', 'delivered'))])
        shipments_total = Shipment.search_count([])
        on_time_rate = (shipments_dispatched / shipments_total * 100.0) if shipments_total else 0.0

        # --- Cold room utilization (as % of capacity) ---
        cold_rooms = ColdRoom.search([])
        utilization = []
        for room in cold_rooms:
            pct = 0.0
            if room.capacity_kg:
                # approximate: active lots weighted evenly isn't meaningful without weight,
                # so show lot count against a soft ceiling of 20 lots/room for a visual bar.
                pct = min(100.0, (room.current_lot_count / 20.0) * 100.0)
            utilization.append({
                'id': room.id,
                'name': room.name,
                'capacity_kg': room.capacity_kg,
                'lots': room.current_lot_count,
                'pct': round(pct, 1),
            })

        # --- Receipts by species (bar chart) ---
        species_groups = Receipt.read_group(domain, ['id'], ['species_id'])
        receipts_by_species = [{
            'label': g['species_id'][1] if g['species_id'] else 'Unspecified',
            'value': g['species_id_count'],
        } for g in species_groups]

        # --- QC pass/fail/to-do breakdown (donut) ---
        # Native quality.check only has none/pass/fail (no "hold" state -- see aqua_on_hold on
        # quality_check.py for the Aqua-specific hold flag, which sits alongside this status).
        qc_groups = QC.read_group(qc_period_domain, ['id'], ['quality_state'])
        qc_breakdown = [{
            'label': QC_STATE_LABELS.get(g['quality_state'], g['quality_state'] or 'Unknown'),
            'value': g['quality_state_count'],
        } for g in qc_groups]

        # --- Shipment status breakdown (donut) ---
        ship_groups = Shipment.read_group([], ['id'], ['state'])
        shipment_breakdown = [{
            'label': SHIPMENT_STATE_LABELS.get(g['state'], g['state'] or 'Unknown'),
            'value': g['state_count'],
        } for g in ship_groups]

        # --- Receipt trend (line chart), bucketed to match the FilterBar's active period ---
        bucket_fn, trend_granularity_label = self._trend_granularity(period, start_date, end_date)
        receipts = Receipt.search(domain + [('receipt_date', '!=', False)], order='receipt_date')
        receipt_buckets = {}
        for r in receipts:
            sort_key, label = bucket_fn(r.receipt_date)
            row = receipt_buckets.setdefault(sort_key, {'label': label, 'value': 0})
            row['value'] += 1
        receipt_trend = [v for k, v in sorted(receipt_buckets.items())][-12:]

        # ══════════════════ Procurement: purchase → storage flow ══════════════════

        # --- Receipt status breakdown (Open / Completed / Cancelled) (donut) ---
        receipt_status_groups = Receipt.read_group(domain, ['id'], ['state'])
        receipt_status_breakdown = [{
            'label': RECEIPT_STATE_LABELS.get(g['state'], g['state'] or 'Unknown'),
            'value': g['state_count'],
        } for g in receipt_status_groups]

        # --- Purchase spend by vendor, top 8 (horizontal bar) ---
        spend_groups = Purchase.read_group(po_domain, ['amount_total:sum'], ['partner_id'])
        spend_by_vendor = sorted([{
            'label': g['partner_id'][1] if g['partner_id'] else 'Unspecified',
            'value': round(g['amount_total'], 2),
        } for g in spend_groups], key=lambda x: x['value'], reverse=True)[:8]

        # --- Received weight by vendor, top 8 (horizontal bar) ---
        weight_groups = Receipt.read_group(domain, ['total_received:sum'], ['vendor_id'])
        weight_by_vendor = sorted([{
            'label': g['vendor_id'][1] if g['vendor_id'] else 'Unspecified',
            'value': round(g['total_received'], 1),
        } for g in weight_groups], key=lambda x: x['value'], reverse=True)[:8]

        # --- Ordered vs Received weight, most recent 8 receipts with a PO (grouped bar) ---
        recent_with_po = Receipt.search(
            domain + [('purchase_order_id', '!=', False)], limit=8, order='receipt_date desc')
        ordered_vs_received = [{
            'label': r.name,
            'ordered': round(r.ordered_qty, 1),
            'received': round(r.total_received, 1),
        } for r in reversed(recent_with_po)]

        # ══════════════════ Procurement: purchase -> INVENTORY (today's stock) ══════════════════
        # This is the part management actually wants to see: once a Catch Receipt clears QC and
        # lands in Storage, it becomes real stock.quant on hand. Everything below is read live
        # off stock.quant / stock.location, not off the Aqua models, so it reflects the true
        # inventory position at this exact moment -- not what the receipts *say* was received.

        Quant = self.env['stock.quant']
        quant_domain = self._raw_material_quant_domain(company_id)
        stock_quants = Quant.search(quant_domain)

        total_stock_on_hand = sum(stock_quants.mapped('quantity'))
        stock_value = sum(q.quantity * q.product_id.standard_price for q in stock_quants)

        # --- Today's Stock by product/species, live on-hand (horizontal bar) ---
        stock_by_product = {}
        for q in stock_quants:
            key = q.product_id.name
            stock_by_product[key] = stock_by_product.get(key, 0.0) + q.quantity
        current_stock_by_product = sorted(
            [{'label': k, 'value': round(v, 1)} for k, v in stock_by_product.items()],
            key=lambda x: x['value'], reverse=True)[:8]

        # --- Where that stock physically sits right now: Input / Quality Control / Storage /
        # etc. -- whatever internal locations this company actually uses (horizontal bar).
        # Material stuck in "Input" or "Quality Control" for days is exactly the kind of
        # bottleneck this chart is meant to surface.
        stock_by_location = {}
        for q in stock_quants:
            key = q.location_id.name or q.location_id.complete_name
            stock_by_location[key] = stock_by_location.get(key, 0.0) + q.quantity
        current_stock_by_location = sorted(
            [{'label': k, 'value': round(v, 1)} for k, v in stock_by_location.items()],
            key=lambda x: x['value'], reverse=True)

        # --- Purchase-to-stock funnel: how much of what was Ordered has actually made it
        # through Received and is sitting in Stock right now (bar). A big drop from Received
        # to In Stock means material is piling up mid-pipeline (QC hold, unprocessed, etc.)
        # rather than actually being on the shelf.
        total_ordered_qty = sum(receipts_for_weight.mapped('ordered_qty'))
        purchase_to_stock_funnel = [
            {'label': 'Ordered', 'value': round(total_ordered_qty, 1)},
            {'label': 'Received', 'value': round(total_weight_received, 1)},
            {'label': 'In Stock Today', 'value': round(total_stock_on_hand, 1)},
        ]

        # --- Weight received trend, same adaptive bucketing/title as the trend charts below ---
        weight_trend_buckets = {}
        for r in sorted(receipts_for_weight.filtered('receipt_date'), key=lambda r: r.receipt_date):
            sort_key, label = bucket_fn(r.receipt_date)
            row = weight_trend_buckets.setdefault(sort_key, {'label': label, 'value': 0.0})
            row['value'] += r.net_weight
        daily_weight_trend = [
            {'label': v['label'], 'value': round(v['value'], 1)}
            for k, v in sorted(weight_trend_buckets.items())
        ][-12:]

        # --- Purchase spend trend (line), same adaptive bucketing as receipt_trend above ---
        po_buckets = {}
        for po in sorted(purchase_orders.filtered(lambda p: p.date_approve or p.date_order),
                          key=lambda p: p.date_approve or p.date_order):
            d = po.date_approve or po.date_order
            sort_key, label = bucket_fn(d)
            row = po_buckets.setdefault(sort_key, {'label': label, 'value': 0.0})
            row['value'] += po.amount_total
        purchase_spend_trend = [
            {'label': v['label'], 'value': round(v['value'], 2)}
            for k, v in sorted(po_buckets.items())
        ][-12:]

        # --- Avg price per kg trend (line) -- spend-weighted, so it tracks the real cost
        # trend management pays for raw material, bucket over bucket (buckets with a PO but
        # no matching weight received, or vice versa, are skipped -- nothing to divide). ---
        weight_buckets = {}
        for r in receipts_for_weight.filtered('receipt_date'):
            sort_key, label = bucket_fn(r.receipt_date)
            row = weight_buckets.setdefault(sort_key, {'label': label, 'value': 0.0})
            row['value'] += r.net_weight
        avg_price_keys = sorted(set(po_buckets) & set(weight_buckets))[-12:]
        avg_price_per_kg_trend = [
            {'label': po_buckets[k]['label'], 'value': round(po_buckets[k]['value'] / weight_buckets[k]['value'], 2)}
            for k in avg_price_keys if weight_buckets[k]['value']
        ]

        # --- Recent Catch Receipts — Purchase to Storage: one row per delivery (the real
        # granularity of "what happened"), enriched with the purchase context (Vendor, PO,
        # Species, Ordered qty) that used to live in a separate, mostly-duplicate table keyed
        # on the same Receipt. A receipt with 2 deliveries now shows as 2 rows with the same
        # Vendor/PO/Species repeated -- not as a receipt-level row plus a second delivery-level
        # table underneath it that says the same thing twice. ---
        Delivery = self.env['aqua.catch.receipt.delivery']
        delivery_domain = [('catch_receipt_id.company_id', '=', company_id)] if company_id else []
        recent_deliveries = Delivery.search(delivery_domain, limit=15, order='id desc')
        recent_receipts_table = [{
            'id': d.id,
            'picking_id': d.picking_id.id,
            'receipt_id': d.catch_receipt_id.id,
            'receipt': d.catch_receipt_id.name or '',
            'vendor': d.catch_receipt_id.vendor_id.name or '',
            'po': d.catch_receipt_id.purchase_order_id.name or '',
            'species': d.catch_receipt_id.species_id.name or '',
            'ordered_qty': round(d.catch_receipt_id.ordered_qty, 1),
            'sequence': d.sequence,
            'transfer': d.picking_id.name or '',
            'batch': d.batch_id.name or '-',
            'lot_number': d.lot_number or '-',
            'backorder_of': d.backorder_of_id.name or '-',
            'quantity': round(d.quantity, 1),
            'receipt_state': RECEIPT_STATE_LABELS.get(d.catch_receipt_id.state, d.catch_receipt_id.state),
            'state': PICKING_STATE_LABELS.get(d.state, d.state or ''),
        } for d in recent_deliveries]

        # ══════════════════ Processing: intake → cold storage flow ══════════════════

        mo_domain = [('company_id', '=', company_id)] if company_id else []
        # Only Aqua processing orders are the ones with a source Catch Receipt.
        mo_domain_aqua = mo_domain + [('catch_receipt_id', '!=', False)]
        if dt_from:
            mo_domain_aqua += [('create_date', '>=', dt_from), ('create_date', '<=', dt_to)]

        all_productions = Production.search(mo_domain_aqua)

        total_processing_orders = len(all_productions)
        total_input_qty = sum(all_productions.mapped('qty_input'))

        # --- Raw material staged for Processing (WIP): quantity currently sitting in the
        # warehouse's Pre-/Post-Production locations -- material already committed to a
        # Processing Order but not yet consumed into finished/by-product output. This is
        # exactly the "AQP/Pre-Production" figure that used to (wrongly) show up as
        # Procurement's "Today's Stock" -- it belongs here instead. ---
        wip_quants = self.env['stock.quant'].search(self._wip_quant_domain(company_id))
        wip_stock_kg = sum(wip_quants.mapped('quantity'))
        wip_by_product = {}
        for q in wip_quants:
            key = q.product_id.name
            wip_by_product[key] = wip_by_product.get(key, 0.0) + q.quantity
        wip_stock_by_product = sorted(
            [{'label': k, 'value': round(v, 1)} for k, v in wip_by_product.items()],
            key=lambda x: x['value'], reverse=True)[:8]

        # --- Processing order status breakdown (donut) ---
        mo_status_groups = Production.read_group(mo_domain_aqua, ['id'], ['state'])
        processing_status_breakdown = [{
            'label': MO_STATE_LABELS.get(g['state'], g['state'] or 'Unknown'),
            'value': g['state_count'],
        } for g in mo_status_groups]

        # --- Input weight by species, last 10 orders (horizontal bar) ---
        species_input = {}
        for p in all_productions:
            key = p.species_id.name or 'Unspecified'
            species_input[key] = species_input.get(key, 0.0) + p.qty_input
        input_qty_by_species = sorted(
            [{'label': k, 'value': round(v, 1)} for k, v in species_input.items()],
            key=lambda x: x['value'], reverse=True)[:8]

        recent_productions = Production.search(mo_domain_aqua, limit=10, order='id desc')

        # --- Blast freeze cycle status (donut) ---
        BlastCycle = self.env['aqua.blast.freeze.cycle']
        blast_groups = BlastCycle.read_group([], ['id'], ['state'])
        blast_freeze_status = [{
            'label': BLAST_STATE_LABELS.get(g['state'], g['state'] or 'Unknown'),
            'value': g['state_count'],
        } for g in blast_groups]
        active_blast_freeze_count = BlastCycle.search_count([('state', '=', 'running')])

        # --- Recent Processing Orders table (intake -> state) ---
        def _ipqc_status(production):
            checks = production.quality_test_ids.filtered(lambda c: c.aqua_test_stage == 'in_process')
            if not checks:
                return 'No Checks'
            if any(c.quality_state == 'fail' for c in checks):
                return 'Fail'
            if any(c.quality_state == 'none' for c in checks):
                return 'Pending'
            return 'Pass'

        recent_processing_table = [{
            'id': p.id,
            'name': p.name,
            'species': p.species_id.name or '',
            'catch_receipt': p.catch_receipt_id.name or '',
            'qty_input': round(p.qty_input, 1),
            'ipqc_status': _ipqc_status(p),
            'state': MO_STATE_LABELS.get(p.state, p.state),
        } for p in recent_productions]

        # ══════════════════ Quality Control: full inspection lifecycle ══════════════════

        qc_all = QC.search(qc_period_domain)
        qc_fail_count = QC.search_count(qc_period_domain + [('quality_state', '=', 'fail')])
        qc_todo_count = QC.search_count(qc_period_domain + [('quality_state', '=', 'none')])
        qc_hold_count = QC.search_count(qc_period_domain + [('aqua_on_hold', '=', True)])

        # --- Per-stage totals & pass rates: IQC (Incoming, at Receiving) / IPQC (In-Process,
        # on the shop floor during manufacturing) / Final QC (Pre-Shipment). Three different
        # gates, three different audiences -- a receiving clerk cares about IQC, a shift
        # supervisor cares about IPQC, so each gets its own number rather than one blended
        # "QC Pass Rate" that hides which stage is actually failing. ---
        def _stage_counts(stage):
            total = QC.search_count(qc_period_domain + [('aqua_test_stage', '=', stage)])
            passed = QC.search_count(qc_period_domain + [('aqua_test_stage', '=', stage), ('quality_state', '=', 'pass')])
            return total, (passed / total * 100.0) if total else 0.0

        iqc_total, iqc_pass_rate = _stage_counts('raw_material')
        ipqc_total, ipqc_pass_rate = _stage_counts('in_process')
        final_qc_total, final_qc_pass_rate = _stage_counts('final')

        # --- IPQC checks by shop-floor operation (Cleaning / Peeling / Deveining /
        # Freezing(IQF) / Grading / Packing) -- where in the process line failures actually
        # happen (horizontal bar, pass vs fail per station). ---
        ipqc_checks = QC.search(qc_period_domain + [('aqua_test_stage', '=', 'in_process')])
        ipqc_by_operation = {}
        for c in ipqc_checks:
            key = c.aqua_operation_name or 'Unspecified'
            bucket = ipqc_by_operation.setdefault(key, {'pass': 0, 'fail': 0, 'other': 0})
            if c.quality_state == 'pass':
                bucket['pass'] += 1
            elif c.quality_state == 'fail':
                bucket['fail'] += 1
            else:
                bucket['other'] += 1
        # Fixed station order matches the routing (AQUA_OPERATION_WORKSHEETS) when present,
        # any other/unspecified operation is appended after.
        station_order = ['Cleaning', 'Peeling', 'Deveining', 'Freezing(IQF)', 'Grading', 'Packing']
        ordered_stations = [s for s in station_order if s in ipqc_by_operation]
        ordered_stations += sorted(k for k in ipqc_by_operation if k not in station_order)
        ipqc_by_operation_chart = {
            'labels': ordered_stations,
            'pass': [ipqc_by_operation[s]['pass'] for s in ordered_stations],
            'fail': [ipqc_by_operation[s]['fail'] for s in ordered_stations],
        }

        histamine_values = [v for v in qc_all.mapped('aqua_histamine_ppm') if v]
        avg_histamine_ppm = (sum(histamine_values) / len(histamine_values)) if histamine_values else 0.0
        sensory_values = [v for v in qc_all.mapped('aqua_sensory_score') if v]
        avg_sensory_score = (sum(sensory_values) / len(sensory_values)) if sensory_values else 0.0

        # --- QC checks by lifecycle stage (donut) ---
        qc_stage_groups = QC.read_group(qc_period_domain, ['id'], ['aqua_test_stage'])
        qc_stage_breakdown = [{
            'label': QC_STAGE_LABELS.get(g['aqua_test_stage'], g['aqua_test_stage'] or 'Unspecified'),
            'value': g['aqua_test_stage_count'],
        } for g in qc_stage_groups]

        # --- Intake decision breakdown, raw material stage only (donut) ---
        intake_groups = QC.read_group(
            qc_period_domain + [('aqua_test_stage', '=', 'raw_material'), ('aqua_intake_decision', '!=', False)],
            ['id'], ['aqua_intake_decision'])
        intake_decision_breakdown = [{
            'label': INTAKE_DECISION_LABELS.get(g['aqua_intake_decision'], g['aqua_intake_decision']),
            'value': g['aqua_intake_decision_count'],
        } for g in intake_groups]

        # --- Antibiotic / sulphite residue screening results (grouped bar) ---
        antibiotic_groups = {g['aqua_antibiotic_result']: g['aqua_antibiotic_result_count']
                              for g in QC.read_group(qc_period_domain, ['id'], ['aqua_antibiotic_result'])}
        sulphite_groups = {g['aqua_sulphite_result']: g['aqua_sulphite_result_count']
                            for g in QC.read_group(qc_period_domain, ['id'], ['aqua_sulphite_result'])}
        residue_screening = {
            'labels': [RESIDUE_RESULT_LABELS[k] for k in ('not_tested', 'not_detected', 'detected')],
            'antibiotic': [antibiotic_groups.get(k, 0) for k in ('not_tested', 'not_detected', 'detected')],
            'sulphite': [sulphite_groups.get(k, 0) for k in ('not_tested', 'not_detected', 'detected')],
        }

        # --- QC checks trend, bucketed to match the FilterBar's active period (line) ---
        qc_with_dates = qc_all.filtered(lambda c: c.control_date)
        qc_buckets = {}
        for c in qc_with_dates:
            sort_key, label = bucket_fn(c.control_date)
            row = qc_buckets.setdefault(sort_key, {'label': label, 'value': 0})
            row['value'] += 1
        qc_trend = [v for k, v in sorted(qc_buckets.items())][-12:]

        # --- Rejected quantity by species, raw material rejections (horizontal bar) ---
        rejected_by_species = {}
        for c in qc_all:
            if c.aqua_test_stage == 'raw_material' and c.aqua_rejected_quantity:
                key = c.aqua_catch_receipt_id.species_id.name or 'Unspecified'
                rejected_by_species[key] = rejected_by_species.get(key, 0.0) + c.aqua_rejected_quantity
        rejected_qty_by_species = sorted(
            [{'label': k, 'value': round(v, 1)} for k, v in rejected_by_species.items()],
            key=lambda x: x['value'], reverse=True)[:8]

        # --- Recent Quality Checks table ---
        recent_qc = QC.search(qc_period_domain, limit=10, order='control_date desc')
        recent_qc_table = [{
            'id': c.id,
            'name': c.name,
            'stage': QC_STAGE_SHORT_LABELS.get(c.aqua_test_stage, c.aqua_test_stage or ''),
            'source': c.aqua_catch_receipt_id.name or c.aqua_processing_order_id.name or c.aqua_pack_order_id.name or '-',
            'operation': c.aqua_operation_name or '-',
            'result': QC_STATE_LABELS.get(c.quality_state, c.quality_state),
            'decision': INTAKE_DECISION_LABELS.get(c.aqua_intake_decision, c.aqua_intake_decision or '-'),
            'histamine_ppm': round(c.aqua_histamine_ppm, 1),
            'core_temp_c': round(c.aqua_core_temp_c, 1),
            'on_hold': c.aqua_on_hold,
        } for c in recent_qc]

        # ══════════════════ Period-over-period comparison (FilterBar "Compare to") ══════════════════
        # Only computed when the person actually picked a comparison basis -- an extra couple
        # of searches on every dashboard load otherwise for a feature that's off by default.
        comparison_pct = {}
        comparison_label = ''
        if compare != 'none' and start_date and end_date:
            prior_start, prior_end = self._compute_prior_range(compare, start_date, end_date)
            prior_dt_from, prior_dt_to = self._datetime_bounds(prior_start, prior_end)
            if prior_dt_from:
                prior = self._flow_kpis(prior_dt_from, prior_dt_to, company_id)
                current_snapshot = {
                    'total_receipts': total_receipts,
                    'total_weight_received': total_weight_received,
                    'total_purchase_spend': total_purchase_spend,
                    'avg_price_per_kg': avg_price_per_kg,
                    'qc_total': qc_total,
                    'qc_pass_rate': qc_pass_rate,
                    'iqc_pass_rate': iqc_pass_rate,
                    'ipqc_pass_rate': ipqc_pass_rate,
                    'total_processing_orders': total_processing_orders,
                    'total_input_qty': total_input_qty,
                }
                for key, cur in current_snapshot.items():
                    prior_val = prior.get(key, 0)
                    if prior_val:
                        comparison_pct[key] = (cur - prior_val) / prior_val * 100.0
                    else:
                        comparison_pct[key] = 100.0 if cur else 0.0
                comparison_label = COMPARE_LABELS.get(compare, '')

        return {
            'comparison_pct': comparison_pct,
            'comparison_label': comparison_label,
            'total_receipts': total_receipts,
            'accepted_receipts': accepted_receipts,
            'cancelled_receipts': cancelled_receipts,
            'rejection_rate': rejection_rate,
            'total_weight_received': total_weight_received,
            'active_vendor_count': active_vendor_count,
            'total_purchase_spend': total_purchase_spend,
            'avg_price_per_kg': avg_price_per_kg,
            'qc_pass_rate': qc_pass_rate,
            'on_time_dispatch_rate': on_time_rate,
            'cold_room_utilization': utilization,
            'receipts_by_species': receipts_by_species,
            'qc_breakdown': qc_breakdown,
            'shipment_breakdown': shipment_breakdown,
            'receipt_trend': receipt_trend,
            'trend_granularity_label': trend_granularity_label,
            'receipt_status_breakdown': receipt_status_breakdown,
            'spend_by_vendor': spend_by_vendor,
            'weight_by_vendor': weight_by_vendor,
            'ordered_vs_received': ordered_vs_received,
            'recent_receipts_table': recent_receipts_table,

            # Live Inventory: current stock position (live off stock.quant)
            'total_stock_on_hand': total_stock_on_hand,
            'stock_value': stock_value,
            'current_stock_by_product': current_stock_by_product,
            'current_stock_by_location': current_stock_by_location,
            'purchase_to_stock_funnel': purchase_to_stock_funnel,
            'daily_weight_trend': daily_weight_trend,
            'purchase_spend_trend': purchase_spend_trend,
            'avg_price_per_kg_trend': avg_price_per_kg_trend,

            # Processing tab
            'total_processing_orders': total_processing_orders,
            'total_input_qty': total_input_qty,
            'wip_stock_kg': wip_stock_kg,
            'wip_stock_by_product': wip_stock_by_product,
            'active_blast_freeze_count': active_blast_freeze_count,
            'processing_status_breakdown': processing_status_breakdown,
            'input_qty_by_species': input_qty_by_species,
            'blast_freeze_status': blast_freeze_status,
            'recent_processing_table': recent_processing_table,

            # Quality Control tab
            'qc_total': qc_total,
            'qc_fail_count': qc_fail_count,
            'qc_todo_count': qc_todo_count,
            'qc_hold_count': qc_hold_count,
            'iqc_total': iqc_total,
            'iqc_pass_rate': iqc_pass_rate,
            'ipqc_total': ipqc_total,
            'ipqc_pass_rate': ipqc_pass_rate,
            'final_qc_total': final_qc_total,
            'final_qc_pass_rate': final_qc_pass_rate,
            'ipqc_by_operation_chart': ipqc_by_operation_chart,
            'avg_histamine_ppm': avg_histamine_ppm,
            'avg_sensory_score': avg_sensory_score,
            'qc_stage_breakdown': qc_stage_breakdown,
            'intake_decision_breakdown': intake_decision_breakdown,
            'residue_screening': residue_screening,
            'qc_trend': qc_trend,
            'rejected_qty_by_species': rejected_qty_by_species,
            'recent_qc_table': recent_qc_table,
        }

    # ------------------------------------------------------------------
    # Drill-down: click-through from a KPI tile or a chart element to the
    # actual Odoo records behind that number. Kept server-side (rather than
    # rebuilding the same domains in JS) so qc_period_domain etc. stay defined
    # in exactly one place.
    # ------------------------------------------------------------------
    def get_drill_records(self, drill_type, filter_value=None, company_id=None):
        domain = [('company_id', '=', company_id)] if company_id else []

        if drill_type == 'total_receipts':
            return self._drill_receipts(domain)

        if drill_type == 'accepted_receipts':
            return self._drill_receipts(domain + [('state', '=', 'completed')])

        if drill_type == 'cancelled_receipts':
            return self._drill_receipts(domain + [('state', '=', 'cancelled')])

        if drill_type == 'receipt_status_breakdown':
            state_domain = domain
            if filter_value:
                state_domain = domain + [('state', '=', RECEIPT_LABEL_TO_STATE.get(filter_value, filter_value))]
            return self._drill_receipts(state_domain)

        if drill_type == 'spend_by_vendor':
            po_domain = [('state', 'in', ('purchase', 'done'))]
            if company_id:
                po_domain += [('company_id', '=', company_id)]
            if filter_value:
                po_domain += [('partner_id.name', '=', filter_value)]
            pos = self.env['purchase.order'].search(po_domain, limit=200)
            return {
                'model': 'purchase.order',
                'columns': [
                    {'field': 'name', 'label': 'PO', 'fmt': 'string'},
                    {'field': 'vendor', 'label': 'Vendor', 'fmt': 'string'},
                    {'field': 'amount_total', 'label': 'Total', 'fmt': 'number'},
                    {'field': 'date_order', 'label': 'Order Date', 'fmt': 'date'},
                ],
                'records': [{
                    'id': p.id,
                    'name': p.name,
                    'vendor': p.partner_id.name or '',
                    'amount_total': p.amount_total,
                    'date_order': p.date_order,
                } for p in pos],
            }

        if drill_type in ('weight_by_vendor', 'ordered_vs_received'):
            weight_domain = domain
            if drill_type == 'weight_by_vendor' and filter_value:
                weight_domain = domain + [('vendor_id.name', '=', filter_value)]
            elif drill_type == 'ordered_vs_received' and filter_value:
                weight_domain = domain + [('name', '=', filter_value)]
            return self._drill_receipts(weight_domain)

        if drill_type == 'total_weight_received':
            return self._drill_receipts(domain)

        if drill_type == 'total_purchase_spend':
            po_domain = [('state', 'in', ('purchase', 'done'))]
            if company_id:
                po_domain += [('company_id', '=', company_id)]
            pos = self.env['purchase.order'].search(po_domain, limit=200)
            return {
                'model': 'purchase.order',
                'columns': [
                    {'field': 'name', 'label': 'PO', 'fmt': 'string'},
                    {'field': 'vendor', 'label': 'Vendor', 'fmt': 'string'},
                    {'field': 'amount_total', 'label': 'Total', 'fmt': 'number'},
                    {'field': 'date_order', 'label': 'Order Date', 'fmt': 'date'},
                ],
                'records': [{
                    'id': p.id,
                    'name': p.name,
                    'vendor': p.partner_id.name or '',
                    'amount_total': p.amount_total,
                    'date_order': p.date_order,
                } for p in pos],
            }

        if drill_type == 'species':
            return self._drill_receipts(domain + [('species_id.name', '=', filter_value)])

        if drill_type in ('total_stock_on_hand', 'stock_value', 'current_stock_by_product',
                           'current_stock_by_location'):
            quant_domain = self._raw_material_quant_domain(company_id)
            if drill_type == 'current_stock_by_product' and filter_value:
                quant_domain += [('product_id.name', '=', filter_value)]
            elif drill_type == 'current_stock_by_location' and filter_value:
                quant_domain += [('location_id.name', '=', filter_value)]
            return self._drill_quants(quant_domain)

        if drill_type == 'purchase_to_stock_funnel':
            if filter_value == 'In Stock Today':
                return self._drill_quants(self._raw_material_quant_domain(company_id))
            return self._drill_receipts(domain)

        if drill_type == 'daily_weight_trend':
            recs = self.env['aqua.catch.receipt'].search(domain + [('receipt_date', '!=', False)])
            recs = recs.filtered(lambda r: self._trend_bucket_matches(r.receipt_date, filter_value))
            return self._drill_receipts_records(recs)

        if drill_type == 'avg_price_per_kg_trend':
            recs = self.env['aqua.catch.receipt'].search(domain + [('receipt_date', '!=', False)])
            recs = recs.filtered(lambda r: self._trend_bucket_matches(r.receipt_date, filter_value))
            return self._drill_receipts_records(recs)

        if drill_type == 'purchase_spend_trend':
            po_domain = [('state', 'in', ('purchase', 'done'))]
            if company_id:
                po_domain += [('company_id', '=', company_id)]
            pos = self.env['purchase.order'].search(po_domain)
            pos = pos.filtered(
                lambda p: (p.date_approve or p.date_order)
                and self._trend_bucket_matches(p.date_approve or p.date_order, filter_value))
            return {
                'model': 'purchase.order',
                'columns': [
                    {'field': 'name', 'label': 'PO', 'fmt': 'string'},
                    {'field': 'vendor', 'label': 'Vendor', 'fmt': 'string'},
                    {'field': 'amount_total', 'label': 'Total', 'fmt': 'number'},
                    {'field': 'date_order', 'label': 'Order Date', 'fmt': 'date'},
                ],
                'records': [{
                    'id': p.id,
                    'name': p.name,
                    'vendor': p.partner_id.name or '',
                    'amount_total': p.amount_total,
                    'date_order': p.date_order,
                } for p in pos],
            }

        if drill_type == 'receipt_trend':
            recs = self.env['aqua.catch.receipt'].search(domain + [('receipt_date', '!=', False)])
            recs = recs.filtered(lambda r: self._trend_bucket_matches(r.receipt_date, filter_value))
            return self._drill_receipts_records(recs)

        if drill_type in ('qc_pass_rate', 'qc_breakdown'):
            qc_domain = list(AQUA_QC_DOMAIN)
            if drill_type == 'qc_breakdown' and filter_value:
                qc_domain = qc_domain + [('quality_state', '=', QC_LABEL_TO_STATE.get(filter_value, filter_value))]
            elif drill_type == 'qc_pass_rate':
                qc_domain = qc_domain + [('quality_state', '=', 'pass')]
            checks = self.env['quality.check'].search(qc_domain, limit=200)
            return {
                'model': 'quality.check',
                'columns': [
                    {'field': 'name', 'label': 'Check', 'fmt': 'string'},
                    {'field': 'quality_state', 'label': 'Result', 'fmt': 'status'},
                    {'field': 'control_date', 'label': 'Control Date', 'fmt': 'date'},
                ],
                'records': [{
                    'id': c.id,
                    'name': c.name,
                    'quality_state': QC_STATE_LABELS.get(c.quality_state, c.quality_state),
                    'control_date': c.control_date,
                } for c in checks],
            }

        if drill_type in ('on_time_dispatch_rate', 'shipment_breakdown'):
            ship_domain = []
            if drill_type == 'shipment_breakdown' and filter_value:
                ship_domain = [('state', '=', SHIPMENT_LABEL_TO_STATE.get(filter_value, filter_value))]
            elif drill_type == 'on_time_dispatch_rate':
                ship_domain = [('state', 'in', ('dispatched', 'delivered'))]
            shipments = self.env['aqua.shipment'].search(ship_domain, limit=200)
            return {
                'model': 'aqua.shipment',
                'columns': [
                    {'field': 'name', 'label': 'Shipment', 'fmt': 'string'},
                    {'field': 'customer', 'label': 'Customer', 'fmt': 'string'},
                    {'field': 'state', 'label': 'Status', 'fmt': 'status'},
                    {'field': 'etd', 'label': 'ETD', 'fmt': 'date'},
                ],
                'records': [{
                    'id': s.id,
                    'name': s.name,
                    'customer': s.customer_id.name or '',
                    'state': SHIPMENT_STATE_LABELS.get(s.state, s.state),
                    'etd': s.etd,
                } for s in shipments],
            }

        if drill_type == 'processing_status_breakdown':
            mo_domain = domain + [('catch_receipt_id', '!=', False)]
            if filter_value:
                mo_domain += [('state', '=', MO_LABEL_TO_STATE.get(filter_value, filter_value))]
            productions = self.env['mrp.production'].search(mo_domain, limit=200)
            return self._drill_processing_records(productions)

        if drill_type == 'input_qty_by_species':
            mo_domain = domain + [('catch_receipt_id', '!=', False)]
            if filter_value:
                mo_domain += [('species_id.name', '=', filter_value)]
            productions = self.env['mrp.production'].search(mo_domain, limit=200)
            return self._drill_processing_records(productions)

        if drill_type == 'total_processing_orders':
            productions = self.env['mrp.production'].search(
                domain + [('catch_receipt_id', '!=', False)], limit=200)
            return self._drill_processing_records(productions)

        if drill_type in ('wip_stock_kg', 'wip_stock_by_product'):
            wip_domain = self._wip_quant_domain(company_id)
            if drill_type == 'wip_stock_by_product' and filter_value:
                wip_domain += [('product_id.name', '=', filter_value)]
            return self._drill_quants(wip_domain)

        if drill_type == 'blast_freeze_status':
            blast_domain = []
            if filter_value:
                blast_domain = [('state', '=', BLAST_LABEL_TO_STATE.get(filter_value, filter_value))]
            cycles = self.env['aqua.blast.freeze.cycle'].search(blast_domain, limit=200)
            return {
                'model': 'aqua.blast.freeze.cycle',
                'columns': [
                    {'field': 'name', 'label': 'Cycle', 'fmt': 'string'},
                    {'field': 'cold_room', 'label': 'Cold Room', 'fmt': 'string'},
                    {'field': 'state', 'label': 'Status', 'fmt': 'status'},
                    {'field': 'duration_hours', 'label': 'Duration (h)', 'fmt': 'number'},
                ],
                'records': [{
                    'id': c.id,
                    'name': c.name,
                    'cold_room': c.cold_room_id.name or '',
                    'state': BLAST_STATE_LABELS.get(c.state, c.state),
                    'duration_hours': round(c.duration_hours, 1),
                } for c in cycles],
            }

        if drill_type == 'qc_stage_breakdown':
            qc_domain = list(AQUA_QC_DOMAIN)
            if filter_value:
                qc_domain += [('aqua_test_stage', '=', QC_STAGE_LABEL_TO_STAGE.get(filter_value, filter_value))]
            return self._drill_qc_records(qc_domain)

        if drill_type == 'intake_decision_breakdown':
            qc_domain = list(AQUA_QC_DOMAIN) + [('aqua_test_stage', '=', 'raw_material')]
            if filter_value:
                qc_domain += [('aqua_intake_decision', '=',
                                INTAKE_DECISION_LABEL_TO_VALUE.get(filter_value, filter_value))]
            return self._drill_qc_records(qc_domain)

        if drill_type == 'qc_trend':
            checks = self.env['quality.check'].search(AQUA_QC_DOMAIN)
            checks = checks.filtered(lambda c: c.control_date and self._trend_bucket_matches(c.control_date, filter_value))
            return self._drill_qc_records_records(checks)

        if drill_type == 'rejected_qty_by_species':
            qc_domain = list(AQUA_QC_DOMAIN) + [
                ('aqua_test_stage', '=', 'raw_material'), ('aqua_rejected_quantity', '>', 0)]
            if filter_value:
                qc_domain += [('aqua_catch_receipt_id.species_id.name', '=', filter_value)]
            return self._drill_qc_records(qc_domain)

        if drill_type == 'qc_total':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN))

        if drill_type == 'qc_fail_count':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN) + [('quality_state', '=', 'fail')])

        if drill_type == 'qc_hold_count':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN) + [('aqua_on_hold', '=', True)])

        if drill_type == 'iqc_total':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN) + [('aqua_test_stage', '=', 'raw_material')])

        if drill_type == 'ipqc_total':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN) + [('aqua_test_stage', '=', 'in_process')])

        if drill_type == 'final_qc_total':
            return self._drill_qc_records(list(AQUA_QC_DOMAIN) + [('aqua_test_stage', '=', 'final')])

        if drill_type == 'ipqc_by_operation_chart':
            qc_domain = list(AQUA_QC_DOMAIN) + [('aqua_test_stage', '=', 'in_process')]
            if filter_value:
                qc_domain += [('aqua_operation_name', '=', filter_value)]
            return self._drill_qc_records(qc_domain)

        return {'model': False, 'columns': [], 'records': []}

    def _drill_processing_records(self, productions):
        return {
            'model': 'mrp.production',
            'columns': [
                {'field': 'name', 'label': 'Processing Order', 'fmt': 'string'},
                {'field': 'species', 'label': 'Species', 'fmt': 'string'},
                {'field': 'qty_input', 'label': 'Input (kg)', 'fmt': 'number'},
                {'field': 'state', 'label': 'Status', 'fmt': 'status'},
            ],
            'records': [{
                'id': p.id,
                'name': p.name,
                'species': p.species_id.name or '',
                'qty_input': round(p.qty_input, 1),
                'state': MO_STATE_LABELS.get(p.state, p.state),
            } for p in productions],
        }

    def _drill_qc_records(self, qc_domain):
        checks = self.env['quality.check'].search(qc_domain, limit=200)
        return self._drill_qc_records_records(checks)

    def _drill_qc_records_records(self, checks):
        return {
            'model': 'quality.check',
            'columns': [
                {'field': 'name', 'label': 'Check', 'fmt': 'string'},
                {'field': 'stage', 'label': 'Stage', 'fmt': 'string'},
                {'field': 'quality_state', 'label': 'Result', 'fmt': 'status'},
                {'field': 'decision', 'label': 'Decision', 'fmt': 'string'},
                {'field': 'control_date', 'label': 'Control Date', 'fmt': 'date'},
            ],
            'records': [{
                'id': c.id,
                'name': c.name,
                'stage': QC_STAGE_LABELS.get(c.aqua_test_stage, c.aqua_test_stage or ''),
                'quality_state': QC_STATE_LABELS.get(c.quality_state, c.quality_state),
                'decision': INTAKE_DECISION_LABELS.get(c.aqua_intake_decision, c.aqua_intake_decision or '-'),
                'control_date': c.control_date,
            } for c in checks],
        }

    def _drill_quants(self, quant_domain):
        quants = self.env['stock.quant'].search(quant_domain, limit=200)
        return {
            'model': 'stock.quant',
            'columns': [
                {'field': 'product', 'label': 'Product', 'fmt': 'string'},
                {'field': 'location', 'label': 'Location', 'fmt': 'string'},
                {'field': 'lot', 'label': 'Lot/Serial', 'fmt': 'string'},
                {'field': 'quantity', 'label': 'Quantity (kg)', 'fmt': 'number'},
            ],
            'records': [{
                'id': q.id,
                'product': q.product_id.name or '',
                'location': q.location_id.complete_name or '',
                'lot': q.lot_id.name or '',
                'quantity': round(q.quantity, 1),
            } for q in quants],
        }

    def _drill_receipts(self, domain):
        recs = self.env['aqua.catch.receipt'].search(domain, limit=200)
        return self._drill_receipts_records(recs)

    def _drill_receipts_records(self, recs):
        return {
            'model': 'aqua.catch.receipt',
            'columns': [
                {'field': 'name', 'label': 'Receipt', 'fmt': 'string'},
                {'field': 'vendor', 'label': 'Vendor', 'fmt': 'string'},
                {'field': 'po', 'label': 'PO', 'fmt': 'string'},
                {'field': 'species', 'label': 'Species', 'fmt': 'string'},
                {'field': 'ordered_qty', 'label': 'Ordered (kg)', 'fmt': 'number'},
                {'field': 'net_weight', 'label': 'Net Weight (kg)', 'fmt': 'number'},
                {'field': 'state', 'label': 'Status', 'fmt': 'status'},
            ],
            'records': [{
                'id': r.id,
                'name': r.name,
                'vendor': r.vendor_id.name or '',
                'po': r.purchase_order_id.name or '',
                'species': r.species_id.name or '',
                'ordered_qty': r.ordered_qty,
                'net_weight': r.net_weight,
                'state': RECEIPT_STATE_LABELS.get(r.state, r.state),
            } for r in recs],
        }