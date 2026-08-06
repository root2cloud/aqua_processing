from odoo import fields, models, _


class QualityCheckWizard(models.TransientModel):
    """The quick Pass/Fail pop-up (opened from the picking's "Quality Checks" button while
    validating a transfer) stays lean on purpose -- it is a guided, one-decision-at-a-time
    flow, not a data-entry screen. Only the handful of fields an inspector genuinely needs at
    the gate, in the moment, are exposed here as related fields. Everything else in the Aqua
    checklist (sensory, chemical, microbiology, documentation...) is filled in on the full
    quality.check record, reached either afterwards from the Picking's Quality Checks smart
    button, or directly from here via "Full Inspection Checklist"."""
    _inherit = 'quality.check.wizard'

    aqua_test_stage = fields.Selection(related='current_check_id.aqua_test_stage', readonly=True)
    aqua_catch_receipt_id = fields.Many2one(related='current_check_id.aqua_catch_receipt_id', readonly=True)
    aqua_core_temp_c = fields.Float(related='current_check_id.aqua_core_temp_c', readonly=False)
    aqua_intake_decision = fields.Selection(related='current_check_id.aqua_intake_decision', readonly=False)
    aqua_decision_notes = fields.Text(related='current_check_id.aqua_decision_notes', readonly=False)

    def action_open_aqua_details(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': _('Aqua Quality Check Details'),
            'res_model': 'quality.check',
            'view_mode': 'form',
            'res_id': self.current_check_id.id,
            'target': 'current',
        }