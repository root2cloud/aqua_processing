from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class AquaPackOrder(models.Model):
    _name = 'aqua.pack.order'
    _description = 'Pack Order'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'create_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    processing_order_id = fields.Many2one('mrp.production', string='Processing Order')
    cold_room_id = fields.Many2one('aqua.cold.room')
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    carton_ids = fields.One2many('aqua.carton', 'pack_order_id', string='Cartons')
    # Comodel changed from the retired aqua.quality.test to native quality.check, via its new
    # aqua_pack_order_id field (see models/quality/quality_check.py). Field name kept identical
    # so no view changes are needed, and so aqua_trace_link.py's snapshot
    # (pack_order.quality_test_ids.ids) keeps working unchanged.
    quality_test_ids = fields.One2many('quality.check', 'aqua_pack_order_id', string='QC Tests')
    weight_tolerance = fields.Float(string='Weight Tolerance (%)', default=2.0)

    state = fields.Selection([
        ('draft', 'Draft'), ('ready', 'Ready'), ('loaded', 'Loaded'), ('shipped', 'Shipped'),
    ], default='draft', tracking=True)

    carton_count = fields.Integer(compute='_compute_counts')

    def _compute_counts(self):
        for rec in self:
            rec.carton_count = len(rec.carton_ids)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.pack.order') or 'New'
        return super().create(vals_list)

    def unlink(self):
        for rec in self:
            if rec.carton_ids:
                raise UserError('Cannot delete a pack order once cartons have been built against it.')
        return super().unlink()

    @api.constrains('processing_order_id')
    def _check_processing_order_stage(self):
        for rec in self:
            if rec.processing_order_id and rec.processing_order_id.stage_state != 'packing_ready':
                raise ValidationError(
                    f"Processing Order '{rec.processing_order_id.name}' has not reached the "
                    f"'Packing Ready' stage yet (currently '{rec.processing_order_id.stage_state}'). "
                    f"A Pack Order can only be linked once the Aqua Stage is Packing Ready."
                )

    def action_confirm(self):
        for rec in self:
            rec._check_component_availability()
        self.write({'state': 'ready'})

    def _check_component_availability(self):
        # ------------------------------------------------------------------
        # FIX: previously action_confirm() moved straight to 'ready' with no
        # check on the linked Processing Order's stock components. Packaging
        # materials (Poly Bag, Master Carton Box, Packing Tape Roll) were
        # only ever caught as "Not Available" deep inside the Manufacturing
        # screen, after the user had already believed the Pack Order was
        # good to go. This surfaces the same shortage here, before confirm.
        # ------------------------------------------------------------------
        self.ensure_one()
        production = self.processing_order_id
        if not production:
            return
        short_moves = production.move_raw_ids.filtered(
            lambda m: m.state not in ('done', 'cancel') and m.state != 'assigned'
        )
        if short_moves:
            names = ', '.join(short_moves.mapped('product_id.display_name'))
            raise UserError(
                f"Cannot confirm this Pack Order: the linked Processing Order '{production.name}' "
                f"has components not yet available/reserved: {names}. Ensure packaging materials "
                f"(poly bags, cartons, tape, etc.) are in stock and reserved before confirming."
            )


    def action_reset_to_draft(self):
        for rec in self:
            if rec.state not in ('loaded', 'shipped'):
                raise UserError('Only a Loaded or Shipped pack order can be reset to Ready.')
        self.write({'state': 'ready'})

    def action_view_cartons(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Cartons',
            'res_model': 'aqua.carton', 'view_mode': 'list,form',
            'domain': [('pack_order_id', '=', self.id)],
        }

    def action_view_traceability(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Traceability Record',
            'res_model': 'aqua.trace.link', 'view_mode': 'list,form',
            'domain': [('pack_order_id', '=', self.id)],
        }


class AquaCarton(models.Model):
    _name = 'aqua.carton'
    _description = 'Carton'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    pack_order_id = fields.Many2one('aqua.pack.order', required=True, ondelete='cascade')
    pallet_id = fields.Many2one('aqua.pallet', string='Pallet')
    product_id = fields.Many2one('product.product', string='Grade / Product',
        help='Which graded finished product this carton holds, e.g. Frozen Shrimp Jumbo. '
             'A Carton has no identity without this -- previously it was just an anonymous '
             'weight bucket with no link to which size grade was actually packed inside it.')
    total_weight = fields.Float(string='Total Weight (kg)')
    unit_pack_weight = fields.Float(string='Retail Pack Weight (kg)', default=1.0,
        help='Weight of one individual retail pack inside this carton, e.g. 1 kg. Used only '
             'to derive Pack Count below; change this if a grade is packed in a different '
             'retail unit size.')
    pack_count = fields.Integer(compute='_compute_pack_count', store=True, string='Retail Packs',
        help='Total Weight / Retail Pack Weight, e.g. a 20 kg carton of 1 kg packs = 20 packs. '
             'This matches the "1 kg pack" quantities declared during Packing -- it is derived, '
             'not separately entered, so it always stays consistent with Total Weight.')
    barcode = fields.Char()

    @api.depends('total_weight', 'unit_pack_weight')
    def _compute_pack_count(self):
        for rec in self:
            rec.pack_count = int(rec.total_weight / rec.unit_pack_weight) if rec.unit_pack_weight else 0

    @api.constrains('total_weight')
    def _check_weight_tolerance(self):
        # ------------------------------------------------------------------
        # FIX: a Pack Order now spans a whole batch with multiple grades
        # (Jumbo/Large/Medium/Small) in one packing session, since product_id
        # was added. Comparing a carton's weight against the average of ALL
        # cartons in the order -- across every grade -- is meaningless: a
        # 20 kg Jumbo carton was never supposed to match a 15 kg Small
        # carton's average. Tolerance is now checked only against other
        # cartons of the SAME product/grade within this pack order.
        # ------------------------------------------------------------------
        for rec in self:
            order = rec.pack_order_id
            if not order:
                continue
            siblings = order.carton_ids.filtered(lambda c: c.product_id == rec.product_id)
            if not siblings:
                continue
            expected = sum(siblings.mapped('total_weight')) / len(siblings)
            tolerance = order.weight_tolerance / 100.0
            if expected and abs(rec.total_weight - expected) > expected * tolerance:
                raise ValidationError(
                    f'Carton weight {rec.total_weight} kg falls outside the pack order\'s '
                    f'configured tolerance band ({order.weight_tolerance}%) for '
                    f'{rec.product_id.display_name or "this grade"}.'
                )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.carton') or 'New'
        return super().create(vals_list)


class AquaPallet(models.Model):
    _name = 'aqua.pallet'
    _description = 'Pallet'
    _inherit = ['mail.thread']

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    carton_ids = fields.One2many('aqua.carton', 'pallet_id', string='Cartons Loaded')
    shipment_id = fields.Many2one('aqua.shipment', string='Shipment')
    gross_weight = fields.Float(compute='_compute_gross_weight', store=True)
    state = fields.Selection([
        ('ready', 'Ready'), ('loaded', 'Loaded'), ('shipped', 'Shipped'),
    ], default='ready', tracking=True)

    carton_count = fields.Integer(compute='_compute_carton_count')

    @api.depends('carton_ids.total_weight')
    def _compute_gross_weight(self):
        for rec in self:
            rec.gross_weight = sum(rec.carton_ids.mapped('total_weight'))

    def _compute_carton_count(self):
        for rec in self:
            rec.carton_count = len(rec.carton_ids)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.pallet') or 'New'
        return super().create(vals_list)

    def action_reset_to_draft(self):
        for rec in self:
            if rec.state not in ('loaded', 'shipped'):
                raise UserError('Only a Loaded or Shipped pallet can be reset to Ready.')
        self.write({'state': 'ready'})

    def action_view_shipment(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Shipment',
            'res_model': 'aqua.shipment', 'view_mode': 'form',
            'res_id': self.shipment_id.id,
        }


class AquaLabelTemplate(models.Model):
    _name = 'aqua.label.template'
    _description = 'Label Template'

    name = fields.Char(required=True)
    label_format = fields.Selection([('retail', 'Retail'), ('carton', 'Carton'), ('pallet', 'Pallet')],
                                     required=True)
    qweb_template_ref = fields.Char(help='External ID of the QWeb report template used to render this label')
    active = fields.Boolean(default=True)