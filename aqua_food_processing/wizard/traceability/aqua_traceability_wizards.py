from odoo import fields, models


class AquaTraceQueryWizard(models.TransientModel):
    _name = 'aqua.trace.query'
    _description = 'Trace Query Wizard (Forward / Backward / Recall)'

    direction = fields.Selection([
        ('forward', 'Trace Forward (Catch Receipt -> Shipments)'),
        ('backward', 'Trace Backward (Lot/Customer -> Vendor)'),
        ('recall', 'Recall Simulation'),
    ], required=True, default='forward')

    catch_receipt_id = fields.Many2one('aqua.catch.receipt')
    lot_id = fields.Many2one('stock.lot')
    customer_id = fields.Many2one('res.partner')

    trace_link_ids = fields.Many2many('aqua.trace.link', string='Result', readonly=True)

    def action_search(self):
        self.ensure_one()
        domain = []
        if self.direction == 'forward' and self.catch_receipt_id:
            domain = [('catch_receipt_id', '=', self.catch_receipt_id.id)]
        elif self.direction in ('backward', 'recall') and self.lot_id:
            domain = ['|', ('carton_id.name', '=', self.lot_id.name), ('pallet_id.name', '=', self.lot_id.name)]
        elif self.customer_id:
            domain = [('customer_id', '=', self.customer_id.id)]
        links = self.env['aqua.trace.link'].search(domain)
        self.trace_link_ids = [(6, 0, links.ids)]
        return {
            'type': 'ir.actions.act_window',
            'name': 'Trace Results',
            'res_model': 'aqua.trace.link',
            'view_mode': 'list,form',
            'domain': [('id', 'in', links.ids)],
        }
