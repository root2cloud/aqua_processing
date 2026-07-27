from odoo import api, fields, models
from odoo.exceptions import ValidationError


class AquaVendorRateContract(models.Model):
    _name = 'aqua.vendor.rate.contract'
    _description = 'Vendor Rate Contract'
    _order = 'date_start desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    vendor_id = fields.Many2one('res.partner', required=True, string='Vendor')
    species_id = fields.Many2one('aqua.species', required=True)
    rate = fields.Float(required=True, help='Rate per kg')
    date_start = fields.Date(required=True)
    date_end = fields.Date(required=True)
    active = fields.Boolean(default=True)
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    catch_receipt_ids = fields.One2many('aqua.catch.receipt', 'rate_contract_id', string='Catch Receipts')
    catch_receipt_count = fields.Integer(compute='_compute_catch_receipt_count')

    @api.constrains('date_start', 'date_end')
    def _check_dates(self):
        for rec in self:
            if rec.date_start >= rec.date_end:
                raise ValidationError('Start date must be before end date.')

    def _compute_catch_receipt_count(self):
        for rec in self:
            rec.catch_receipt_count = len(rec.catch_receipt_ids)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.vendor.rate.contract') or 'New'
        return super().create(vals_list)

    def action_view_catch_receipts(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Catch Receipts',
            'res_model': 'aqua.catch.receipt',
            'view_mode': 'list,form',
            'domain': [('rate_contract_id', '=', self.id)],
        }
