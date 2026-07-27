from odoo import fields, models


class AquaRecordLabResultWizard(models.TransientModel):
    _name = 'aqua.record.lab.result.wizard'
    _description = 'Record Lab Result Wizard'

    quality_test_id = fields.Many2one('aqua.quality.test', required=True)
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
            'sensory_score': self.sensory_score,
            'histamine_ppm': self.histamine_ppm,
            'ph_value': self.ph_value,
            'moisture_percentage': self.moisture_percentage,
            'total_plate_count': self.total_plate_count,
            'e_coli_count': self.e_coli_count,
            'salmonella_detected': self.salmonella_detected,
        })


class AquaIssueCoaWizard(models.TransientModel):
    _name = 'aqua.issue.coa.wizard'
    _description = 'Issue Certificate of Analysis Wizard'

    quality_test_ids = fields.Many2many('aqua.quality.test', required=True)
    certifying_body_id = fields.Many2one('aqua.certifying.body')

    def action_confirm(self):
        self.ensure_one()
        non_pass = self.quality_test_ids.filtered(lambda t: t.result_state != 'pass')
        if non_pass:
            from odoo.exceptions import UserError
            raise UserError('Only tests with a Pass result can be included on a Certificate of Analysis.')
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

    quality_test_id = fields.Many2one('aqua.quality.test', required=True)
    reason = fields.Text(required=True)

    def action_confirm(self):
        self.ensure_one()
        self.quality_test_id.action_hold()
        self.quality_test_id.message_post(body=f'Placed on hold: {self.reason}')
