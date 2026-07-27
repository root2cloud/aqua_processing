from odoo import api, fields, models
from odoo.exceptions import UserError


class AquaWeighmentEntryWizard(models.TransientModel):
    _name = 'aqua.weighment.entry.wizard'
    _description = 'Weighment Entry Wizard'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True)
    gross_weight = fields.Float(string='Gross Weight (kg)', required=True)
    tare_weight = fields.Float(string='Tare Weight (kg)')
    net_weight = fields.Float(string='Net Weight (kg)', compute='_compute_net_weight', store=True, readonly=False)

    @api.depends('gross_weight', 'tare_weight')
    def _compute_net_weight(self):
        for rec in self:
            rec.net_weight = rec.gross_weight - rec.tare_weight

    def action_confirm(self):
        self.ensure_one()
        self.catch_receipt_id.write({
            'gross_weight': self.gross_weight,
            'tare_weight': self.tare_weight,
            'net_weight': self.net_weight,
        })
        self.catch_receipt_id.action_confirm_weighment()


class AquaGradeCatchWizard(models.TransientModel):
    _name = 'aqua.grade.catch.wizard'
    _description = 'Grade Catch Wizard'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True)
    line_ids = fields.One2many('aqua.grade.catch.wizard.line', 'wizard_id', string='Grade Split')

    def action_confirm(self):
        self.ensure_one()
        for line in self.line_ids:
            self.env['aqua.catch.receipt.line'].create({
                'catch_receipt_id': self.catch_receipt_id.id,
                'grading_standard_id': line.grading_standard_id.id,
                'quantity': line.quantity,
            })
        self.catch_receipt_id.action_grade()


class AquaGradeCatchWizardLine(models.TransientModel):
    _name = 'aqua.grade.catch.wizard.line'
    _description = 'Grade Catch Wizard Line'

    wizard_id = fields.Many2one('aqua.grade.catch.wizard')
    grading_standard_id = fields.Many2one('aqua.grading.standard', required=True)
    quantity = fields.Float(string='Quantity (kg)', required=True)