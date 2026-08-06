from odoo import fields, models
from odoo.exceptions import UserError


class AquaRecordLabResultWizard(models.TransientModel):
    _name = 'aqua.record.lab.result.wizard'
    _description = 'Record Lab Result Wizard'

    quality_test_id = fields.Many2one('quality.check', required=True, string='Quality Check')
    sensory_score = fields.Float()
    histamine_ppm = fields.Float()
    ph_value = fields.Float()
    moisture_percentage = fields.Float()
    total_plate_count = fields.Float()
    e_coli_count = fields.Float()
    salmonella_detected = fields.Boolean()

    def action_confirm(self):
        self.ensure_one()
        self.quality_test_id.write({
            'aqua_sensory_score': self.sensory_score,
            'aqua_histamine_ppm': self.histamine_ppm,
            'aqua_ph_value': self.ph_value,
            'aqua_moisture_percentage': self.moisture_percentage,
            'aqua_total_plate_count': self.total_plate_count,
            'aqua_e_coli_count': self.e_coli_count,
            'aqua_salmonella_detected': self.salmonella_detected,
        })


class AquaIssueCoaWizard(models.TransientModel):
    _name = 'aqua.issue.coa.wizard'
    _description = 'Issue Certificate of Analysis Wizard'

    quality_test_ids = fields.Many2many('quality.check', required=True, string='Quality Checks')
    certifying_body_id = fields.Many2one('aqua.certifying.body')

    def action_confirm(self):
        self.ensure_one()
        non_pass = self.quality_test_ids.filtered(lambda t: t.quality_state != 'pass')
        if non_pass:
            raise UserError('Only checks with a Passed status can be included on a Certificate of Analysis.')
        coa = self.env['aqua.certificate.of.analysis'].create({
            'certifying_body_id': self.certifying_body_id.id,
            'quality_test_ids': [(6, 0, self.quality_test_ids.ids)],
        })
        return {
            'type': 'ir.actions.act_window', 'name': 'Certificate of Analysis',
            'res_model': 'aqua.certificate.of.analysis', 'view_mode': 'form', 'res_id': coa.id,
        }


class AquaQuarantineHoldWizard(models.TransientModel):
    _name = 'aqua.quarantine.hold.wizard'
    _description = 'Quarantine/Hold Batch Wizard'

    quality_test_id = fields.Many2one('quality.check', required=True, string='Quality Check')
    reason = fields.Text(required=True)

    def action_confirm(self):
        self.ensure_one()
        # Native quality.check only supports none/pass/fail -- action_aqua_hold() sets the
        # aqua_on_hold flag instead of a 'hold' quality_state (see quality_check.py).
        self.quality_test_id.action_aqua_hold()
        self.quality_test_id.message_post(body=f'Placed on hold: {self.reason}')