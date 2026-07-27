from odoo import api, fields, models


class AquaProcessingOrder(models.Model):
    _inherit = 'mrp.production'
    _description = 'Processing Order (extends Manufacturing Order)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', string='Source Catch Receipt')
    species_id = fields.Many2one('aqua.species', related='catch_receipt_id.species_id', store=True)

    # ------------------------------------------------------------------
    # REMOVED: processing_stage_id / stage_state (Selection: receiving,
    # grading, cleaning, filleting, packing_ready) and their two action
    # methods, action_start_stage() / action_complete_stage().
    #
    # Confirmed via a full-module grep that no button, wizard, or
    # automated hook anywhere ever called either action method -- the
    # field was permanently frozen at its default ('receiving'), which is
    # exactly why a completed Freezing order was observed showing
    # "Receiving" as its active stage on the status bar. It was decorative
    # dead code, not a working state machine.
    #
    # It is also structurally redundant now that the module uses one real
    # Manufacturing Order per stage (Cleaning MO, Peeling MO, Freezing MO,
    # Packing MO): which MO/product you are looking at already tells you
    # the stage -- product_id and bom_id are the real, trustworthy source
    # of that information, not a second, hand-maintained field that can
    # (and did) drift out of sync. The list/form views now show
    # product_id directly as "Stage Output" instead.
    #
    # The 'filleting' option was also simply wrong terminology for a
    # shrimp process (filleting applies to fish, not shrimp cleaning/
    # peeling), a further sign this Selection list was not built against
    # this business's actual stages.
    # ------------------------------------------------------------------

    yield_record_ids = fields.One2many('aqua.yield.record', 'processing_order_id', string='Yield Records')
    byproduct_record_ids = fields.One2many('aqua.byproduct.record', 'processing_order_id', string='By-products')
    pack_order_ids = fields.One2many('aqua.pack.order', 'processing_order_id', string='Pack Orders')
    quality_test_ids = fields.One2many('aqua.quality.test', 'processing_order_id', string='QC Tests')

    # ------------------------------------------------------------------
    # FIX qty_input was a manually typed
    # Float, completely disconnected from what this Manufacturing Order
    # actually consumed on its raw material moves (move_raw_ids). A user
    # could type any number here regardless of real stock movement, and
    # yield_percentage below was therefore only ever as trustworthy as
    # that manual entry. It is now computed from real, done stock moves.
    #
    # VERSION NOTE: this reads move_raw_ids.quantity, which is the done-
    # quantity field name on stock.move as of Odoo 17+ (it replaced the
    # older quantity_done field). Verify this field name against your
    # exact installed Odoo 18 build before deploying -- if your core
    # still exposes quantity_done instead, swap it below.
    # ------------------------------------------------------------------
    # ------------------------------------------------------------------
    # FIX qty_input was a manually typed
    # Float, completely disconnected from what this Manufacturing Order
    # actually consumed on its raw material moves (move_raw_ids). A user
    # could type any number here regardless of real stock movement, and
    # yield_percentage below was therefore only ever as trustworthy as
    # that manual entry. It is now computed from real, done stock moves.
    #
    # REVISION 2 CORRECTION: under the single-Manufacturing-Order
    # structure, move_raw_ids now contains BOTH the kg-based raw material
    # (Raw Shrimp) AND the Units-based packaging materials (Poly Bag,
    # Master Carton Box, Packing Tape Roll) on the same order, since all
    # four stages now live inside one MO. The original version of this
    # compute summed ALL done raw moves regardless of product, which
    # silently added packaging Units straight into a field labelled
    # "Input Qty (kg)" -- e.g. 100 kg Raw Shrimp + 1 + 1 + 0.10 Units
    # produced a meaningless 102.10. This was not a problem under the
    # original 4-Manufacturing-Order structure, where every component in
    # a given MO was always kg -- it only surfaced once stages were
    # merged into one order. Restricted below to only the Weight UoM
    # category so packaging materials are correctly excluded.
    #
    # VERSION NOTE: this reads move_raw_ids.quantity, which is the done-
    # quantity field name on stock.move as of Odoo 17+ (it replaced the
    # older quantity_done field). Verify this field name against your
    # exact installed Odoo 18 build before deploying -- if your core
    # still exposes quantity_done instead, swap it below. Also verify the
    # XML ID 'uom.product_uom_categ_kgm' matches the Weight category in
    # your database (it is Odoo's standard id for "Weight", but a
    # localisation or prior customisation could differ).
    # ------------------------------------------------------------------
    qty_input = fields.Float(
        string='Input Qty (kg)', compute='_compute_qty_input', store=True, readonly=True,
        help='Automatically computed from the quantities actually consumed on this order\'s '
             'raw material moves, restricted to Weight (kg) components only -- packaging '
             'materials tracked in Units are correctly excluded.')
    yield_percentage = fields.Float(
        compute='_compute_yield_percentage', store=True, string='Product Yield %',
        help='Finished product weight-equivalent / Input Qty (kg), expressed as a percentage. '
             'Requires the finished product\'s Weight (kg) field to be set on the Inventory tab '
             'of its product form -- see code comment. This is the FINISHED PRODUCT only; '
             'by-products are tracked separately below.')
    byproduct_yield_percentage = fields.Float(
        compute='_compute_yield_percentage', store=True, string='By-product Yield %',
        help='By-product Qty (kg) / Input Qty (kg), expressed as a percentage.')

    @api.depends('move_raw_ids.state', 'move_raw_ids.quantity', 'move_raw_ids.product_id')
    def _compute_qty_input(self):
        weight_category = self.env.ref('uom.product_uom_categ_kgm', raise_if_not_found=False)
        for rec in self:
            done_moves = rec.move_raw_ids.filtered(lambda m: m.state == 'done')
            if weight_category:
                done_moves = done_moves.filtered(
                    lambda m: m.product_id.uom_id.category_id == weight_category
                )
            rec.qty_input = sum(done_moves.mapped('quantity'))

    yield_record_count = fields.Integer(compute='_compute_counts')
    byproduct_record_count = fields.Integer(compute='_compute_counts')
    quality_test_count = fields.Integer(compute='_compute_counts')
    pack_order_count = fields.Integer(compute='_compute_counts')

    # ------------------------------------------------------------------
    # FIX (follow-up to the qty_input fix): yield_percentage previously
    # depended only on yield_record_ids.qty_output -- the custom log
    # table created by the Record Yield wizard. If an order is produced
    # the normal Odoo way (typing a quantity into the native Quantity
    # field and clicking Produce, without going through that wizard),
    # zero aqua.yield.record rows exist, and yield showed 0.00% even
    # though real output was sitting in stock. This now reads the real,
    # done finished-goods moves first, and only falls back to the manual
    # log if no real move exists yet (e.g. viewing before Produce).
    #
    # REVISION 2 CORRECTION: under the single-Manufacturing-Order
    # structure, the finished product (Frozen Shrimp 30 kg Box) is
    # tracked in Units, not kg -- so "produced quantity" is now something
    # like 1.00 (one box), not a weight. Directly dividing 1.00 by a
    # kg-based Input Qty produced a meaningless yield (observed as 0.98,
    # i.e. 0.98%, on a real batch). This version converts produced Units
    # to a weight-equivalent using the finished product's own configured
    # Weight (kg) field, and adds the real by-product weight, before
    # comparing against Input Qty -- giving a dimensionally correct
    # (output kg / input kg) percentage as intended.
    #
    # ACTION REQUIRED: this only works if "Frozen Shrimp 30 kg Box" has
    # its Weight field set to 30.00 (kg) on the product's Inventory tab.
    # If Weight is left at 0, this falls back to using the raw produced
    # count (1.00) with no conversion, which will silently reproduce the
    # same wrong-looking yield -- check this field before relying on the
    # number.
    #
    # VERSION NOTE: move_byproduct_ids is the standard mrp.production
    # field for by-product stock moves in Odoo 17/18; move_finished_ids/
    # move_raw_ids/move_byproduct_ids.quantity is the done-quantity field
    # name as of Odoo 17+ (replaced quantity_done). Verify both against
    # your exact installed core, and verify the XML id
    # 'uom.product_uom_categ_kgm' matches your Weight category.
    # ------------------------------------------------------------------
    @api.depends('qty_input',
                 'move_finished_ids.state', 'move_finished_ids.quantity', 'move_finished_ids.product_id',
                 'move_byproduct_ids.state', 'move_byproduct_ids.quantity', 'move_byproduct_ids.product_id')
    def _compute_yield_percentage(self):
        weight_category = self.env.ref('uom.product_uom_categ_kgm', raise_if_not_found=False)
        for rec in self:
            finished_moves = rec.move_finished_ids.filtered(
                lambda m: m.state == 'done' and m.product_id == rec.product_id
            )
            produced_qty = sum(finished_moves.mapped('quantity'))
            produced_weight = produced_qty * rec.product_id.weight if rec.product_id.weight else produced_qty

            byproduct_moves = rec.move_byproduct_ids.filtered(lambda m: m.state == 'done')
            if weight_category:
                byproduct_moves = byproduct_moves.filtered(
                    lambda m: m.product_id.uom_id.category_id == weight_category
                )
            byproduct_weight = sum(byproduct_moves.mapped('quantity'))

            manual_output = sum(rec.yield_record_ids.mapped('qty_output'))
            product_output = produced_weight or manual_output

            rec.yield_percentage = (product_output / rec.qty_input * 100.0) if rec.qty_input else 0.0
            rec.byproduct_yield_percentage = (byproduct_weight / rec.qty_input * 100.0) if rec.qty_input else 0.0

    def _compute_counts(self):
        for rec in self:
            rec.yield_record_count = len(rec.yield_record_ids)
            rec.byproduct_record_count = len(rec.byproduct_record_ids)
            rec.quality_test_count = len(rec.quality_test_ids)
            rec.pack_order_count = len(rec.pack_order_ids)

    def action_done(self):
        # Delegates to native MRP "Mark as Done"; aqua stage should already be packing_ready
        return super().button_mark_done() if hasattr(super(), 'button_mark_done') else True

    def action_view_yield_records(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Yield Records',
            'res_model': 'aqua.yield.record', 'view_mode': 'list,form',
            'domain': [('processing_order_id', '=', self.id)],
        }

    def action_view_byproduct_records(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'By-products',
            'res_model': 'aqua.byproduct.record', 'view_mode': 'list,form',
            'domain': [('processing_order_id', '=', self.id)],
        }

    def action_view_quality_tests(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'QC Tests',
            'res_model': 'aqua.quality.test', 'view_mode': 'list,form',
            'domain': [('processing_order_id', '=', self.id)],
        }

    def action_view_source_catch_receipt(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Source Catch Receipt',
            'res_model': 'aqua.catch.receipt', 'view_mode': 'form',
            'res_id': self.catch_receipt_id.id,
        }


class AquaProcessingStage(models.Model):
    _name = 'aqua.processing.stage'
    _description = 'Processing Stage Configuration'
    _order = 'sequence'

    name = fields.Char(required=True)
    sequence = fields.Integer(default=10)
    work_center_id = fields.Many2one('mrp.workcenter', string='Work Center')
    active = fields.Boolean(default=True)