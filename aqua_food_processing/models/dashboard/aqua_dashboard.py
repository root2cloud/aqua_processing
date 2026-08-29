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
    'raw_material': 'Raw Material (Receiving)', 'in_process': 'In-Process', 'final': 'Final / Pre-Shipment',
}
QC_STAGE_LABEL_TO_STAGE = {v: k for k, v in QC_STAGE_LABELS.items()}

INTAKE_DECISION_LABELS = {'accept': 'Accept', 'reject': 'Reject', 'downgrade': 'Downgrade / Conditional'}
INTAKE_DECISION_LABEL_TO_VALUE = {v: k for k, v in INTAKE_DECISION_LABELS.items()}

RESIDUE_RESULT_LABELS = {'not_tested': 'Not Tested', 'not_detected': 'Not Detected', 'detected': 'Detected'}


class AquaDashboard(models.TransientModel):
    _name = 'aqua.dashboard'
    _description = 'Aqua Dashboard Data Provider'

    def get_dashboard_data(self, company_id=None):
        domain = [('company_id', '=', company_id)] if company_id else []
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
        purchase_orders = Purchase.search(po_domain)
        total_purchase_spend = sum(purchase_orders.mapped('amount_total'))
        avg_price_per_kg = (total_purchase_spend / total_weight_received) if total_weight_received else 0.0

        qc_total = QC.search_count(AQUA_QC_DOMAIN)
        qc_pass = QC.search_count(AQUA_QC_DOMAIN + [('quality_state', '=', 'pass')])
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
        qc_groups = QC.read_group(AQUA_QC_DOMAIN, ['id'], ['quality_state'])
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

        # --- Weekly receipt trend, last 8 weeks (line chart) ---
        receipts = Receipt.search(domain + [('receipt_date', '!=', False)], order='receipt_date')
        weekly = {}
        for r in receipts:
            week_key = r.receipt_date.strftime('%Y-W%W')
            weekly[week_key] = weekly.get(week_key, 0) + 1
        weekly_sorted = sorted(weekly.items())[-8:]
        receipt_trend = [{'label': k, 'value': v} for k, v in weekly_sorted]

        # --- Average yield % across recent processing orders ---
        productions = Production.search([], limit=10, order='id desc')
        yield_trend = [{
            'label': p.name,
            'value': round(p.yield_percentage, 1),
        } for p in reversed(productions)]

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

        # --- Recent Catch Receipts table (purchase order -> receipt -> weight -> status) ---
        recent_receipts = Receipt.search(domain, limit=10, order='receipt_date desc')
        recent_receipts_table = [{
            'id': r.id,
            'name': r.name,
            'vendor': r.vendor_id.name or '',
            'po': r.purchase_order_id.name or '',
            'species': r.species_id.name or '',
            'ordered_qty': round(r.ordered_qty, 1),
            'net_weight': round(r.net_weight, 1),
            'total_received': round(r.total_received, 1),
            'state': RECEIPT_STATE_LABELS.get(r.state, r.state),
        } for r in recent_receipts]

        # ══════════════════ Processing: intake → yield → cold storage flow ══════════════════

        mo_domain = [('company_id', '=', company_id)] if company_id else []
        # Only Aqua processing orders are the ones with a source Catch Receipt.
        mo_domain_aqua = mo_domain + [('catch_receipt_id', '!=', False)]

        all_productions = Production.search(mo_domain_aqua)
        done_productions = all_productions.filtered(lambda p: p.state == 'done')

        total_processing_orders = len(all_productions)
        total_input_qty = sum(all_productions.mapped('qty_input'))
        avg_yield_pct = (sum(done_productions.mapped('yield_percentage')) / len(done_productions)) if done_productions else 0.0
        avg_byproduct_yield_pct = (sum(done_productions.mapped('byproduct_yield_percentage')) / len(done_productions)) if done_productions else 0.0

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

        # --- By-product yield trend, last 10 orders (line) ---
        recent_productions = Production.search(mo_domain_aqua, limit=10, order='id desc')
        byproduct_yield_trend = [{
            'label': p.name, 'value': round(p.byproduct_yield_percentage, 1),
        } for p in reversed(recent_productions)]

        # --- Blast freeze cycle status (donut) ---
        BlastCycle = self.env['aqua.blast.freeze.cycle']
        blast_groups = BlastCycle.read_group([], ['id'], ['state'])
        blast_freeze_status = [{
            'label': BLAST_STATE_LABELS.get(g['state'], g['state'] or 'Unknown'),
            'value': g['state_count'],
        } for g in blast_groups]
        active_blast_freeze_count = BlastCycle.search_count([('state', '=', 'running')])

        # --- Recent Processing Orders table (intake -> yield -> state) ---
        recent_processing_table = [{
            'id': p.id,
            'name': p.name,
            'species': p.species_id.name or '',
            'catch_receipt': p.catch_receipt_id.name or '',
            'qty_input': round(p.qty_input, 1),
            'yield_percentage': round(p.yield_percentage, 1),
            'byproduct_yield_percentage': round(p.byproduct_yield_percentage, 1),
            'state': MO_STATE_LABELS.get(p.state, p.state),
        } for p in recent_productions]

        # ══════════════════ Quality Control: full inspection lifecycle ══════════════════

        qc_all = QC.search(AQUA_QC_DOMAIN)
        qc_fail_count = QC.search_count(AQUA_QC_DOMAIN + [('quality_state', '=', 'fail')])
        qc_todo_count = QC.search_count(AQUA_QC_DOMAIN + [('quality_state', '=', 'none')])
        qc_hold_count = QC.search_count(AQUA_QC_DOMAIN + [('aqua_on_hold', '=', True)])

        histamine_values = [v for v in qc_all.mapped('aqua_histamine_ppm') if v]
        avg_histamine_ppm = (sum(histamine_values) / len(histamine_values)) if histamine_values else 0.0
        sensory_values = [v for v in qc_all.mapped('aqua_sensory_score') if v]
        avg_sensory_score = (sum(sensory_values) / len(sensory_values)) if sensory_values else 0.0

        # --- QC checks by lifecycle stage (donut) ---
        qc_stage_groups = QC.read_group(AQUA_QC_DOMAIN, ['id'], ['aqua_test_stage'])
        qc_stage_breakdown = [{
            'label': QC_STAGE_LABELS.get(g['aqua_test_stage'], g['aqua_test_stage'] or 'Unspecified'),
            'value': g['aqua_test_stage_count'],
        } for g in qc_stage_groups]

        # --- Intake decision breakdown, raw material stage only (donut) ---
        intake_groups = QC.read_group(
            AQUA_QC_DOMAIN + [('aqua_test_stage', '=', 'raw_material'), ('aqua_intake_decision', '!=', False)],
            ['id'], ['aqua_intake_decision'])
        intake_decision_breakdown = [{
            'label': INTAKE_DECISION_LABELS.get(g['aqua_intake_decision'], g['aqua_intake_decision']),
            'value': g['aqua_intake_decision_count'],
        } for g in intake_groups]

        # --- Antibiotic / sulphite residue screening results (grouped bar) ---
        antibiotic_groups = {g['aqua_antibiotic_result']: g['aqua_antibiotic_result_count']
                              for g in QC.read_group(AQUA_QC_DOMAIN, ['id'], ['aqua_antibiotic_result'])}
        sulphite_groups = {g['aqua_sulphite_result']: g['aqua_sulphite_result_count']
                            for g in QC.read_group(AQUA_QC_DOMAIN, ['id'], ['aqua_sulphite_result'])}
        residue_screening = {
            'labels': [RESIDUE_RESULT_LABELS[k] for k in ('not_tested', 'not_detected', 'detected')],
            'antibiotic': [antibiotic_groups.get(k, 0) for k in ('not_tested', 'not_detected', 'detected')],
            'sulphite': [sulphite_groups.get(k, 0) for k in ('not_tested', 'not_detected', 'detected')],
        }

        # --- Weekly QC checks trend, last 8 weeks (line) ---
        qc_with_dates = qc_all.filtered(lambda c: c.control_date)
        qc_weekly = {}
        for c in qc_with_dates:
            week_key = c.control_date.strftime('%Y-W%W')
            qc_weekly[week_key] = qc_weekly.get(week_key, 0) + 1
        qc_weekly_sorted = sorted(qc_weekly.items())[-8:]
        qc_trend = [{'label': k, 'value': v} for k, v in qc_weekly_sorted]

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
        recent_qc = QC.search(AQUA_QC_DOMAIN, limit=10, order='control_date desc')
        recent_qc_table = [{
            'id': c.id,
            'name': c.name,
            'stage': QC_STAGE_LABELS.get(c.aqua_test_stage, c.aqua_test_stage or ''),
            'result': QC_STATE_LABELS.get(c.quality_state, c.quality_state),
            'decision': INTAKE_DECISION_LABELS.get(c.aqua_intake_decision, c.aqua_intake_decision or '-'),
            'histamine_ppm': round(c.aqua_histamine_ppm, 1),
            'core_temp_c': round(c.aqua_core_temp_c, 1),
            'on_hold': c.aqua_on_hold,
        } for c in recent_qc]

        return {
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
            'yield_trend': yield_trend,
            'receipt_status_breakdown': receipt_status_breakdown,
            'spend_by_vendor': spend_by_vendor,
            'weight_by_vendor': weight_by_vendor,
            'ordered_vs_received': ordered_vs_received,
            'recent_receipts_table': recent_receipts_table,

            # Processing tab
            'total_processing_orders': total_processing_orders,
            'total_input_qty': total_input_qty,
            'avg_yield_pct': avg_yield_pct,
            'avg_byproduct_yield_pct': avg_byproduct_yield_pct,
            'active_blast_freeze_count': active_blast_freeze_count,
            'processing_status_breakdown': processing_status_breakdown,
            'input_qty_by_species': input_qty_by_species,
            'byproduct_yield_trend': byproduct_yield_trend,
            'blast_freeze_status': blast_freeze_status,
            'recent_processing_table': recent_processing_table,

            # Quality Control tab
            'qc_total': qc_total,
            'qc_fail_count': qc_fail_count,
            'qc_todo_count': qc_todo_count,
            'qc_hold_count': qc_hold_count,
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
    # rebuilding the same domains in JS) so AQUA_QC_DOMAIN etc. stay defined
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

        if drill_type == 'receipt_trend':
            recs = self.env['aqua.catch.receipt'].search(domain + [('receipt_date', '!=', False)])
            recs = recs.filtered(lambda r: r.receipt_date.strftime('%Y-W%W') == filter_value)
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

        if drill_type in ('yield_trend', 'byproduct_yield_trend'):
            productions = self.env['mrp.production'].search([
                ('name', '=', filter_value),
            ], limit=50)
            return self._drill_processing_records(productions)

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
            checks = checks.filtered(lambda c: c.control_date and c.control_date.strftime('%Y-W%W') == filter_value)
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

        return {'model': False, 'columns': [], 'records': []}

    def _drill_processing_records(self, productions):
        return {
            'model': 'mrp.production',
            'columns': [
                {'field': 'name', 'label': 'Processing Order', 'fmt': 'string'},
                {'field': 'species', 'label': 'Species', 'fmt': 'string'},
                {'field': 'qty_input', 'label': 'Input (kg)', 'fmt': 'number'},
                {'field': 'yield_percentage', 'label': 'Yield %', 'fmt': 'pct'},
                {'field': 'state', 'label': 'Status', 'fmt': 'status'},
            ],
            'records': [{
                'id': p.id,
                'name': p.name,
                'species': p.species_id.name or '',
                'qty_input': round(p.qty_input, 1),
                'yield_percentage': round(p.yield_percentage, 1),
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