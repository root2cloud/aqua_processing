from odoo import api, fields, models


class AquaProcessingOrder(models.Model):
    _inherit = 'mrp.production'
    _description = 'Processing Order (extends Manufacturing Order)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', string='Source Catch Receipt')

    species_id = fields.Many2one('aqua.species', related='catch_receipt_id.species_id', store=True)

    pack_order_ids = fields.One2many('aqua.pack.order', 'processing_order_id', string='Pack Orders')

    # Comodel changed from the retired aqua.quality.test to native quality.check, via its new
    # aqua_processing_order_id field (see models/quality/quality_check.py). Field/method names
    # kept identical so no view changes are needed.
    quality_test_ids = fields.One2many('quality.check', 'aqua_processing_order_id', string='QC Tests')

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

            product_output = produced_weight

            rec.yield_percentage = (product_output / rec.qty_input * 100.0) if rec.qty_input else 0.0
            rec.byproduct_yield_percentage = (byproduct_weight / rec.qty_input * 100.0) if rec.qty_input else 0.0

    def _compute_counts(self):
        for rec in self:
            rec.quality_test_count = len(rec.quality_test_ids)
            rec.pack_order_count = len(rec.pack_order_ids)

    # ------------------------------------------------------------------
    # AUTO COST SHARE: cost_share % on each byproduct line is derived
    # from quantity x sale price, normalized to 100% across all byproduct
    # lines. This replaces manual entry of Cost Share (%).
    # ------------------------------------------------------------------
    def _get_byproduct_cost_share_values(self):
        """Returns {move: value} for each non-done byproduct move, using
        that move's current quantity x its product's sale price."""
        self.ensure_one()
        byproduct_moves = self.move_byproduct_ids.filtered(
            lambda m: m.state not in ('done', 'cancel')
        )
        values = {}
        for move in byproduct_moves:
            qty = move.product_uom_qty or move.quantity or 0.0
            price = move.product_id.lst_price or 0.0
            values[move] = qty * price
        return values

    def _auto_compute_byproduct_cost_share(self):
        """Write cost_share on byproduct moves based on relative sale
        value. Skips (leaves untouched) if no product has a sale price,
        so we never silently zero out a manually-entered value.

        Rounding each line's share to 2 decimals independently can push
        the total slightly above 100.00 (e.g. six lines each rounded up
        by 0.005 -> total 100.01), which Odoo's own constraint on total
        byproduct cost share rejects with "cannot exceed 100". To avoid
        that, every line except the last is rounded normally, and the
        last line is set to whatever share is left over so the total is
        always exactly 100.00.
        """
        for rec in self:
            values = rec._get_byproduct_cost_share_values()
            if not values:
                continue
            total_value = sum(values.values())
            if total_value <= 0:
                continue

            moves = list(values.keys())
            running_total = 0.0
            for move in moves[:-1]:
                share = round((values[move] / total_value) * 100.0, 2)
                move.cost_share = share
                running_total += share

            last_move = moves[-1]
            last_share = round(100.0 - running_total, 2)
            # Guard against float noise producing a tiny negative value
            last_move.cost_share = max(last_share, 0.0)

    @api.onchange('move_byproduct_ids', 'move_byproduct_ids.quantity', 'move_byproduct_ids.product_id')
    def _onchange_byproduct_recompute_cost_share(self):
        """Live preview: recompute cost share % as soon as quantities are
        edited on the By-Products tab, before Mark as Done is ever clicked.
        Purely a UI convenience -- the same calc runs again (and wins) on
        button_mark_done in case anything changed after this preview.

        Note: 'move_byproduct_ids' alone only fires this onchange when a
        line is added/removed. Editing a value (e.g. Quantity) *inside* an
        existing line requires the dotted sub-field paths below, otherwise
        typing a quantity directly on the By-Products tab of the
        Manufacturing Order form (i.e. not going through a work order)
        never triggers a recompute."""
        self._auto_compute_byproduct_cost_share()

    def button_mark_done(self):
        self._auto_compute_byproduct_cost_share()
        return super().button_mark_done()

    def action_done(self):
        # Delegates to native MRP "Mark as Done"; aqua stage should already be packing_ready
        return super().button_mark_done() if hasattr(super(), 'button_mark_done') else True

    def action_view_quality_tests(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'QC Tests',
            'res_model': 'quality.check', 'view_mode': 'list,form',
            'domain': [('aqua_processing_order_id', '=', self.id)],
        }

    def action_view_source_catch_receipt(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Source Catch Receipt',
            'res_model': 'aqua.catch.receipt', 'view_mode': 'form',
            'res_id': self.catch_receipt_id.id,
        }


class AquaProcessingOrderMoveLine(models.Model):
    """Companion hook for AUTO COST SHARE above.

    The onchange on AquaProcessingOrder only fires for edits made live
    inside an open Manufacturing Order form. Byproduct quantities are more
    often registered from the Shop Floor's "Detailed Operations" popup
    (per work order), which writes straight to stock.move.line via RPC --
    no MO form is open to react to, so that onchange never fires for that
    path. Hooking create/write here on stock.move.line ensures the cost
    share is recomputed as soon as a quantity is registered, no matter
    where it was entered from, without waiting for the whole Manufacturing
    Order to be marked done."""
    _inherit = 'stock.move.line'

    def _get_byproduct_productions_to_recompute(self):
        productions = self.env['mrp.production']
        for line in self:
            move = line.move_id
            production = move.production_id
            if production and move in production.move_byproduct_ids:
                productions |= production
        return productions

    @api.model_create_multi
    def create(self, vals_list):
        lines = super().create(vals_list)
        productions = lines._get_byproduct_productions_to_recompute()
        if productions:
            productions._auto_compute_byproduct_cost_share()
        return lines

    def write(self, vals):
        res = super().write(vals)
        if 'quantity' in vals:
            productions = self._get_byproduct_productions_to_recompute()
            if productions:
                productions._auto_compute_byproduct_cost_share()
        return res