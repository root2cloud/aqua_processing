from odoo import api, fields, models
from odoo.exceptions import ValidationError


class AquaYieldRecord(models.Model):
    _name = 'aqua.yield.record'
    _description = 'Processing Yield Record'

    processing_order_id = fields.Many2one('mrp.production', required=True, ondelete='cascade',
                                           string='Processing Order')
    grading_standard_id = fields.Many2one('aqua.grading.standard', string='Grade')
    qty_output = fields.Float(string='Output Qty (kg)', required=True)
    shift = fields.Selection([('morning', 'Morning'), ('afternoon', 'Afternoon'), ('night', 'Night')])
    operator_id = fields.Many2one('hr.employee', string='Operator')
    date = fields.Date(default=fields.Date.context_today)

    @api.constrains('qty_output')
    def _check_qty_output(self):
        for rec in self:
            if rec.processing_order_id.qty_input and rec.qty_output > rec.processing_order_id.qty_input:
                raise ValidationError('Output quantity cannot exceed the processing order\'s input quantity.')


class AquaByproductRecord(models.Model):
    _name = 'aqua.byproduct.record'
    _description = 'By-product Recovery Record'

    processing_order_id = fields.Many2one('mrp.production', required=True, ondelete='cascade',
                                           string='Processing Order')
    byproduct_type = fields.Selection([
        ('shell', 'Shell'), ('head', 'Head'), ('skin', 'Skin'),
        ('bone', 'Bone/Frame'), ('offal', 'Offal'), ('other', 'Other'),
    ], required=True)
    qty_recovered = fields.Float(string='Qty Recovered (kg)', required=True)
    recovery_percentage = fields.Float(compute='_compute_recovery_percentage', store=True)

    @api.depends('qty_recovered', 'processing_order_id.qty_input')
    def _compute_recovery_percentage(self):
        for rec in self:
            qty_input = rec.processing_order_id.qty_input
            rec.recovery_percentage = (rec.qty_recovered / qty_input * 100.0) if qty_input else 0.0
