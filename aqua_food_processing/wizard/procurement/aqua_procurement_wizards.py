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
        self.catch_receipt_id.action_sync_deliveries()


class AquaCreatePoWizard(models.TransientModel):
    _name = 'aqua.create.po.wizard'
    _description = 'Create Purchase Order (from Catch Receipt)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True)
    vendor_id = fields.Many2one('res.partner', string='Vendor', required=True)
    product_id = fields.Many2one('product.product', string='Raw Material Product', required=True)
    quantity = fields.Float(string='Quantity (kg)', required=True)
    price_unit = fields.Float(string='Rate (per kg)', required=True)

    def action_confirm(self):
        """Creates and confirms a real purchase.order for the linked Catch Receipt, and links
        it back -- all in one step, without ever using the generic Many2one "Create" dialog on
        purchase_order_id (that dialog's "open full form" link is what broke the linkage for an
        unsaved Catch Receipt). By the time this wizard opens, the Catch Receipt that triggered
        it (action_open_create_po_wizard) is always already a saved, real record with an id, so
        writing purchase_order_id back onto it here always works cleanly."""
        self.ensure_one()
        po_uom = self.product_id.uom_po_id or self.product_id.uom_id
        purchase_order = self.env['purchase.order'].create({
            'partner_id': self.vendor_id.id,
            'origin': self.catch_receipt_id.name,
            'company_id': self.catch_receipt_id.company_id.id,
            'order_line': [(0, 0, {
                'product_id': self.product_id.id,
                'name': self.product_id.display_name,
                'product_qty': self.quantity,
                'product_uom': po_uom.id,
                'price_unit': self.price_unit,
            })],
        })
        purchase_order.button_confirm()
        self.catch_receipt_id.write({'purchase_order_id': purchase_order.id})
        self.catch_receipt_id.action_sync_deliveries()
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'aqua.catch.receipt',
            'view_mode': 'form',
            'res_id': self.catch_receipt_id.id,
            'target': 'main',
        }
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