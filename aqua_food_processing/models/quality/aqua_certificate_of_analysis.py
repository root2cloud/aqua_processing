from odoo import api, fields, models
from odoo.exceptions import UserError


class AquaCertificateOfAnalysis(models.Model):
    _name = 'aqua.certificate.of.analysis'
    _description = 'Certificate of Analysis'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'issue_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    issue_date = fields.Date(default=fields.Date.context_today)
    certifying_body_id = fields.Many2one('aqua.certifying.body')
    quality_test_ids = fields.One2many('aqua.quality.test', 'certificate_id', string='Quality Tests')
    shipment_id = fields.Many2one('aqua.shipment', string='Shipment')
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)
    snapshot_notes = fields.Text(readonly=True, help='Auto-pulled test results snapshot at creation time')

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.certificate.of.analysis') or 'New'
        records = super().create(vals_list)
        for rec in records:
            rec._snapshot_test_results()
        return records

    def _snapshot_test_results(self):
        self.ensure_one()
        lines = []
        for test in self.quality_test_ids:
            lines.append(f'{test.name}: {test.result_state} (histamine {test.histamine_ppm} ppm)')
        self.snapshot_notes = '\n'.join(lines)

    def unlink(self):
        for rec in self:
            if rec.shipment_id:
                raise UserError('Cannot delete a Certificate of Analysis once linked to a shipment.')
        return super().unlink()


class AquaQualityParameter(models.Model):
    _name = 'aqua.quality.parameter'
    _description = 'Quality Parameter Master'

    name = fields.Char(required=True)
    parameter_type = fields.Selection([
        ('sensory', 'Sensory'), ('chemical', 'Chemical'), ('microbiological', 'Microbiological'),
    ], required=True)
    unit = fields.Char()
    regulatory_limit = fields.Float()
    active = fields.Boolean(default=True)
