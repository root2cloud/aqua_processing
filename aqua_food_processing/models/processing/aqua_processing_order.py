from odoo import api, fields, models


class AquaProcessingOrder(models.Model):
    _inherit = 'mrp.production'
    _description = 'Processing Order (extends Manufacturing Order)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', string='Source Catch Receipt')

    species_id = fields.Many2one('aqua.species', related='catch_receipt_id.species_id', store=True)

    yield_record_ids = fields.One2many('aqua.yield.record', 'processing_order_id', string='Yield Records')

    byproduct_record_ids = fields.One2many('aqua.byproduct.record', 'processing_order_id', string='By-products')

    pack_order_ids = fields.One2many('aqua.pack.order', 'processing_order_id', string='Pack Orders')

    quality_test_ids = fields.One2many('aqua.quality.test', 'processing_order_id', string='QC Tests')

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