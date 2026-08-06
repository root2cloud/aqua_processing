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

        # --- KPI cards ---
        total_receipts = Receipt.search_count(domain)
        accepted_receipts = Receipt.search_count(domain + [('state', '=', 'accepted')])
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
        state_labels = {'none': 'To Do', 'pass': 'Pass', 'fail': 'Fail'}
        qc_breakdown = [{
            'label': state_labels.get(g['quality_state'], g['quality_state'] or 'Unknown'),
            'value': g['quality_state_count'],
        } for g in qc_groups]

        # --- Shipment status breakdown (donut) ---
        ship_groups = Shipment.read_group([], ['id'], ['state'])
        ship_labels = {'booked': 'Booked', 'stuffed': 'Stuffed', 'dispatched': 'Dispatched', 'delivered': 'Delivered'}
        shipment_breakdown = [{
            'label': ship_labels.get(g['state'], g['state'] or 'Unknown'),
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
        productions = Production.search([('catch_receipt_id', '!=', False)], limit=10, order='id desc')
        yield_trend = [{
            'label': p.name,
            'value': round(p.yield_percentage, 1),
        } for p in reversed(productions)]

        return {
            'total_receipts': total_receipts,
            'accepted_receipts': accepted_receipts,
            'qc_pass_rate': qc_pass_rate,
            'on_time_dispatch_rate': on_time_rate,
            'cold_room_utilization': utilization,
            'receipts_by_species': receipts_by_species,
            'qc_breakdown': qc_breakdown,
            'shipment_breakdown': shipment_breakdown,
            'receipt_trend': receipt_trend,
            'yield_trend': yield_trend,
        }