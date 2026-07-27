from odoo import api, fields, models


class AquaTraceLink(models.Model):
    _name = 'aqua.trace.link'
    _description = 'Traceability Link (Catch-to-Customer Genealogy)'
    _order = 'create_date desc'

    name = fields.Char(compute='_compute_name', store=True)

    catch_receipt_id = fields.Many2one('aqua.catch.receipt')
    processing_order_id = fields.Many2one('mrp.production')
    pack_order_id = fields.Many2one('aqua.pack.order')
    carton_id = fields.Many2one('aqua.carton')
    pallet_id = fields.Many2one('aqua.pallet', required=True)
    shipment_id = fields.Many2one('aqua.shipment')

    quality_test_ids = fields.Many2many('aqua.quality.test', string='All QC Tests in Lot Lifecycle')
    customer_id = fields.Many2one('res.partner', string='Customer', related='shipment_id.customer_id', store=True)

    _sql_constraints = [
        ('pallet_uniq', 'unique(pallet_id)', 'Only one trace link is allowed per pallet.'),
    ]

    @api.depends('pallet_id')
    def _compute_name(self):
        for rec in self:
            rec.name = f'Trace-{rec.pallet_id.name}' if rec.pallet_id else 'Trace-New'

    @api.model
    def _create_from_pack_order_confirmation(self, pack_order):
        """Auto-triggered from aqua.pack.order confirmation. Not meant to be called by users."""
        vals_list = []
        for carton in pack_order.carton_ids:
            if carton.pallet_id:
                vals_list.append({
                    'catch_receipt_id': pack_order.processing_order_id.catch_receipt_id.id,
                    'processing_order_id': pack_order.processing_order_id.id,
                    'pack_order_id': pack_order.id,
                    'carton_id': carton.id,
                    'pallet_id': carton.pallet_id.id,
                    'quality_test_ids': [(6, 0, pack_order.quality_test_ids.ids)],
                })
        return self.create(vals_list) if vals_list else self.browse()

    def action_view_catch_receipt(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Catch Receipt',
            'res_model': 'aqua.catch.receipt', 'view_mode': 'form',
            'res_id': self.catch_receipt_id.id,
        }

    def action_view_processing_order(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Processing Order',
            'res_model': 'mrp.production', 'view_mode': 'form',
            'res_id': self.processing_order_id.id,
        }

    def action_view_shipments(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Shipments',
            'res_model': 'aqua.shipment', 'view_mode': 'list,form',
            'domain': [('id', '=', self.shipment_id.id)],
        }
