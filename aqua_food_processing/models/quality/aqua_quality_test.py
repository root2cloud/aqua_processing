from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

HISTAMINE_THRESHOLD_PPM = 200.0  # regulatory ceiling, configurable per company in future


class AquaQualityTest(models.Model):
    _name = 'aqua.quality.test'
    _description = 'Quality Test'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'test_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    test_date = fields.Datetime(default=fields.Datetime.now)
    test_stage = fields.Selection([
        ('raw_material', 'Raw Material (Receiving)'),
        ('in_process', 'In-Process'),
        ('final', 'Final / Pre-Shipment'),
    ], required=True, default='raw_material')

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', string='Catch Receipt')
    processing_order_id = fields.Many2one('mrp.production', string='Processing Order')
    pack_order_id = fields.Many2one('aqua.pack.order', string='Pack Order')
    certificate_id = fields.Many2one('aqua.certificate.of.analysis', string='Certificate of Analysis')

    # Sensory panel
    sensory_score = fields.Float(string='Sensory Score (0-10)')
    sensory_notes = fields.Text()

    # Chemical parameters
    histamine_ppm = fields.Float(string='Histamine (ppm)')
    ph_value = fields.Float(string='pH')
    moisture_percentage = fields.Float(string='Moisture %')

    # Microbiological parameters
    total_plate_count = fields.Float(string='Total Plate Count (cfu/g)')
    e_coli_count = fields.Float(string='E. coli (cfu/g)')
    salmonella_detected = fields.Boolean(string='Salmonella Detected')

    result_state = fields.Selection([
        ('pending', 'Pending'),
        ('pass', 'Pass'),
        ('fail', 'Fail'),
        ('hold', 'Hold'),
    ], default='pending', tracking=True)

    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    @api.constrains('histamine_ppm')
    def _check_histamine(self):
        for rec in self:
            if rec.histamine_ppm < 0:
                raise ValidationError('Histamine ppm cannot be negative.')
            if rec.histamine_ppm > HISTAMINE_THRESHOLD_PPM:
                raise ValidationError(
                    f'Histamine level {rec.histamine_ppm} ppm exceeds the regulatory threshold '
                    f'of {HISTAMINE_THRESHOLD_PPM} ppm. This must be recorded as a failed test, '
                    f'not overridden.'
                )

    def write(self, vals):
        result_fields = {
            'sensory_score', 'histamine_ppm', 'ph_value', 'moisture_percentage',
            'total_plate_count', 'e_coli_count', 'salmonella_detected', 'result_state',
        }
        for rec in self:
            if rec.certificate_id and result_fields.intersection(vals.keys()):
                raise UserError('Result fields cannot be edited once a Certificate of Analysis has been issued.')
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.quality.test') or 'New'
        return super().create(vals_list)

    def _check_certificate_eligible(self):
        self.ensure_one()
        return self.result_state == 'pass'

    def action_pass(self):
        self.write({'result_state': 'pass'})
        for rec in self:
            rec._check_certificate_eligible()

    def action_fail(self):
        self.write({'result_state': 'fail'})

    def action_hold(self):
        self.write({'result_state': 'hold'})

    def action_reset_to_draft(self):
        for rec in self:
            if rec.result_state not in ('hold', 'fail'):
                raise UserError('Only a Hold or Fail result can be reset to Pending.')
        self.write({'result_state': 'pending'})

    def action_view_certificate(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Certificate of Analysis',
            'res_model': 'aqua.certificate.of.analysis', 'view_mode': 'form',
            'res_id': self.certificate_id.id,
        }
