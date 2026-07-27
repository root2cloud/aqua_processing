from odoo import api, fields, models
from odoo.exceptions import UserError


class AquaRecordYieldWizard(models.TransientModel):
    _name = 'aqua.record.yield.wizard'
    _description = 'Record Yield Wizard'

    processing_order_id = fields.Many2one('mrp.production', required=True)
    grading_standard_id = fields.Many2one('aqua.grading.standard')
    qty_output = fields.Float(string='Output Qty (kg)', required=True)
    byproduct_type = fields.Selection([
        ('shell', 'Shell'), ('head', 'Head'), ('skin', 'Skin'),
        ('bone', 'Bone/Frame'), ('offal', 'Offal'), ('other', 'Other'),
    ])
    qty_byproduct = fields.Float(string='By-product Qty (kg)')

    # ------------------------------------------------------------------
    # FIX : previously this wizard only
    # wrote to the custom aqua.yield.record / aqua.byproduct.record log
    # tables. It never touched the real Manufacturing Order, so a user
    # still had to separately open the native MRP "Produce" screen and
    # re-type the same output quantity and lot -- two numbers, one truth,
    # easy to disagree.
    #
    # This wizard now also pushes the entered quantity and lot onto the
    # real mrp.production fields (qty_producing / lot_producing_id) that
    # Odoo's own Produce screen reads from, so the operator's next click
    # is the native "Mark as Done" button with the correct values already
    # sitting there -- one entry, not two.
    #
    # VERSION NOTE: qty_producing and lot_producing_id are the Odoo 17/18
    # mrp.production fields backing the built-in Produce flow. If your
    # installed core names them differently, or your MO has tracking
    # such that a lot must be created rather than selected, adjust
    # lot_producing_id assignment accordingly. This wizard deliberately
    # does NOT call the final "mark as done" / backorder logic itself --
    # that decision (create backorder vs. not) should stay in Odoo's own
    # screen, since guessing it here risks silently finalising a batch
    # the operator did not intend to close.
    # ------------------------------------------------------------------
    lot_id = fields.Many2one(
        'stock.lot', string='Output Lot',
        domain="[('product_id', '=', processing_order_product_id)]",
        help='Optional: select or create the lot for this output. If left blank, you will '
             "still be asked for it on Odoo's native Produce screen.")
    processing_order_product_id = fields.Many2one(
        'product.product', related='processing_order_id.product_id', string='Finished Product')

    def action_confirm(self):
        self.ensure_one()
        if self.processing_order_id.state in ('done', 'cancel'):
            raise UserError('This Processing Order is already %s; open it directly to adjust output.'
                             % self.processing_order_id.state)

        self.env['aqua.yield.record'].create({
            'processing_order_id': self.processing_order_id.id,
            'grading_standard_id': self.grading_standard_id.id,
            'qty_output': self.qty_output,
        })
        if self.byproduct_type and self.qty_byproduct:
            self.env['aqua.byproduct.record'].create({
                'processing_order_id': self.processing_order_id.id,
                'byproduct_type': self.byproduct_type,
                'qty_recovered': self.qty_byproduct,
            })

        # Pre-fill the real production so the native Produce/Mark-as-Done
        # screen the operator opens next already shows this quantity/lot.
        production_vals = {'qty_producing': self.qty_output}
        if self.lot_id:
            production_vals['lot_producing_id'] = self.lot_id.id
        self.processing_order_id.write(production_vals)

        return {
            'type': 'ir.actions.act_window', 'name': self.processing_order_id.display_name,
            'res_model': 'mrp.production', 'view_mode': 'form',
            'res_id': self.processing_order_id.id,
            'target': 'current',
        }


class AquaSplitBatchWizard(models.TransientModel):
    _name = 'aqua.split.batch.wizard'
    _description = 'Split Batch Wizard'

    processing_order_id = fields.Many2one('mrp.production', required=True)
    line_ids = fields.One2many('aqua.split.batch.wizard.line', 'wizard_id')

    def action_confirm(self):
        self.ensure_one()
        for line in self.line_ids:
            self.env['aqua.yield.record'].create({
                'processing_order_id': self.processing_order_id.id,
                'grading_standard_id': line.grading_standard_id.id,
                'qty_output': line.quantity,
            })


class AquaSplitBatchWizardLine(models.TransientModel):
    _name = 'aqua.split.batch.wizard.line'
    _description = 'Split Batch Wizard Line'

    wizard_id = fields.Many2one('aqua.split.batch.wizard')
    grading_standard_id = fields.Many2one('aqua.grading.standard', required=True)
    quantity = fields.Float(string='Quantity (kg)', required=True)