from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class AquaCatchReceipt(models.Model):
    _name = 'aqua.catch.receipt'
    _description = 'Catch Receipt'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'receipt_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    vendor_id = fields.Many2one('res.partner', required=True, tracking=True, string='Vendor / Harvester')
    species_id = fields.Many2one('aqua.species', required=True, tracking=True)
    harvest_method_id = fields.Many2one('aqua.harvest.method')
    rate_contract_id = fields.Many2one('aqua.vendor.rate.contract')
    receipt_date = fields.Datetime(required=True, default=fields.Datetime.now)
    purchase_order_id = fields.Many2one('purchase.order', string='Purchase Order')
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    gross_weight = fields.Float(string='Gross Weight (kg)', tracking=True)
    tare_weight = fields.Float(string='Tare Weight (kg)')
    # ------------------------------------------------------------------
    # FIX: net_weight used to be a plain, independently-entered Float --
    # nothing tied it to gross_weight/tare_weight, so it could be typed
    # in wrong (or left at 0) with no relation to the other two at all.
    # The only guard was the _check_weights constraint rejecting
    # net > gross after the fact. It's now auto-calculated by onchange
    # as gross - tare (the standard Weighment formula), while staying a
    # normal editable field in case a workman needs to correct it by
    # hand for a specific reason (e.g. weighbridge drift).
    # ------------------------------------------------------------------
    net_weight = fields.Float(string='Net Weight (kg)', tracking=True)

    @api.onchange('gross_weight', 'tare_weight')
    def _onchange_weighment(self):
        self.net_weight = self.gross_weight - self.tare_weight

    # ------------------------------------------------------------------
    # Shrimp counting: done by factory workers once the catch arrives,
    # from a small counted sample -- not the whole lot. Sample weight is
    # taken in kg, matching Gross/Tare/Net Weight above (no reason to
    # make a worker weigh in grams when the whole receipt is in kg); the
    # x1000 conversion to grams happens internally in the formula below.
    # Formulas (as supplied):
    #   Average Body Weight (g) = Total Sample Biomass (g) / Shrimp Counted
    #   Count (per kg)          = 1000 / Average Body Weight (g)
    # e.g. 3 kg (3000 g) / 250 shrimp = 12 g avg body weight;
    #      1000 / 12 g = 83.3, i.e. ~83 shrimp per kg.
    # Both formulas as given are correct -- implemented as-is below.
    # ------------------------------------------------------------------
    sample_weight = fields.Float(string='Sample Weight (kg)',
        help='Total weight of the counted sample, in kg (e.g. 3 for 3 kg / 3000 g).')
    sample_count = fields.Integer(string='Shrimp Counted',
        help='Number of shrimp in that sample.')
    avg_body_weight = fields.Float(string='Average Body Weight (g)',
        compute='_compute_shrimp_count', store=True, digits=(16, 2),
        help='(Sample Weight in kg x 1000) / Shrimp Counted.')
    shrimp_count = fields.Float(string='Count (per kg)',
        compute='_compute_shrimp_count', store=True, digits=(16, 1),
        help='1000 / Average Body Weight (g) -- how many shrimp make up one kilogram.')

    @api.depends('sample_weight', 'sample_count')
    def _compute_shrimp_count(self):
        for rec in self:
            rec.avg_body_weight = (rec.sample_weight * 1000.0 / rec.sample_count) if rec.sample_count else 0.0
            rec.shrimp_count = (1000.0 / rec.avg_body_weight) if rec.avg_body_weight else 0.0

    # ------------------------------------------------------------------
    # FIX: batch_number used to be a manually-composed string (date + PO
    # digits + receipt digits + a private serial), generated once on
    # Accept via its own private ir.sequence. That number matched nothing
    # else in Odoo: the actual receipt transfer, once grouped into a
    # Batch Transfer (stock.picking.batch, e.g. "BATCH/00007") from
    # Inventory, has its own real Odoo-sequenced name -- and that's the
    # number the warehouse floor actually works off of.
    #
    # This field now simply mirrors that real batch name: it looks at
    # the Purchase Order's incoming transfer(s) (purchase_order_id
    # .picking_ids) and takes the name of whichever stock.picking.batch
    # they've been added to. There is nothing to enter manually and
    # nothing composed here -- it just follows Odoo's own Batch Transfer
    # sequence. It's blank until someone (or an automation) adds the
    # receipt's transfer to a batch in Inventory, and updates itself
    # automatically the moment that happens, since it's a stored
    # computed field depending on that relation.
    # ------------------------------------------------------------------
    batch_number = fields.Char(string='Batch Number', compute='_compute_batch_number',
        store=True, tracking=True,
        help='Mirrors the name of the Batch Transfer (stock.picking.batch) that this '
             'receipt\'s incoming transfer has been added to in Inventory (e.g. '
             '"BATCH/00007"). Blank until that transfer is added to a batch; updates '
             'itself automatically after that -- nothing to enter here.')

    @api.depends('purchase_order_id.picking_ids.batch_id.name')
    def _compute_batch_number(self):
        for rec in self:
            batch = rec.purchase_order_id.picking_ids.batch_id[:1]
            rec.batch_number = batch.name or False

    # ------------------------------------------------------------------
    # NOTE on receipt_date vs. these two: receipt_date stays a separate,
    # manually-set field -- it's the physical intake time at the gate,
    # entered (or defaulted to "now") before a Purchase Order may even
    # exist yet, since weighment happens first and Accept only creates
    # the PO afterwards. confirmation_date and arrival_date below are a
    # different pair of dates entirely: they're mirrors of the PO's own
    # dates, and stay blank until that PO exists and reaches those
    # stages. Not merged into receipt_date because overwriting it would
    # lose the actual gate-intake time this receipt was weighed at.
    # ------------------------------------------------------------------
    confirmation_date = fields.Datetime(string='Confirmation Date', compute='_compute_po_dates',
        store=True, tracking=True,
        help='Mirrors the linked Purchase Order\'s Confirmation Date. Blank until that '
             'Purchase Order is confirmed.')
    arrival_date = fields.Datetime(string='Arrival', compute='_compute_po_dates',
        store=True, tracking=True,
        help='Mirrors the linked Purchase Order\'s Arrival date -- its Effective Date once '
             'the receipt transfer is done, otherwise its Expected Arrival.')

    @api.depends('purchase_order_id.date_approve', 'purchase_order_id.effective_date',
                 'purchase_order_id.date_planned')
    def _compute_po_dates(self):
        for rec in self:
            po = rec.purchase_order_id
            rec.confirmation_date = po.date_approve or False
            rec.arrival_date = po.effective_date or po.date_planned or False

    lot_number = fields.Char(string='Lot/Serial Number', compute='_compute_lot_number',
        store=True, tracking=True,
        help='Mirrors the Lot/Serial Number recorded on the incoming transfer\'s Detailed '
             'Operations for this receipt\'s raw-material product. Blank until that\'s set.')

    @api.depends('purchase_order_id.picking_ids.move_line_ids.lot_id.name', 'product_id', 'species_id')
    def _compute_lot_number(self):
        for rec in self:
            product = rec.product_id or rec._get_product(rec.species_id, raise_if_missing=False)
            move_lines = rec.purchase_order_id.picking_ids.move_line_ids.filtered(
                lambda ml: product and ml.product_id == product and ml.lot_id)
            rec.lot_number = move_lines[:1].lot_id.name or False

    # ------------------------------------------------------------------
    # FIX : Previously, purchase_order_id existed as a plain, optional Many2one
    # that nothing in this file ever set. Accepting a Catch Receipt only
    # changed its own state field -- it never created a Purchase Order,
    # never touched stock, and never produced the raw-material lot that
    # the rest of the module (Processing Order, Yield Record, etc.)
    # assumes already exists. A user following this app alone would have
    # no actual Raw Shrimp (or any species) in Inventory at all.
    #
    # This adds product_id (defaulted from the selected Species) and has
    # action_accept() create and confirm a real purchase.order for the
    # net weight received, at the vendor rate contract's rate if one is
    # linked. Deliberately NOT automated further than button_confirm():
    # the actual receipt (button_validate on the resulting picking) is
    # left for the user to complete via the normal Purchase/Inventory
    # screens, because your own warehouse is configured for a 3-step
    # Receive -> Quality Control -> Store flow (see the setup
    # documentation, Section 4) -- a real human QC checkpoint belongs
    # there, and auto-validating the receipt here would silently skip it.
    #
    # VERSION NOTE: purchase.order / purchase.order.line field names
    # (product_qty, product_uom, price_unit) and button_confirm() are
    # stable across recent Odoo versions, so this part is low-risk.
    # Where you may need to adjust: uom_po_id vs uom_id on the product
    # (some products don't define a distinct purchase UoM), and whatever
    # your GST/tax defaults require on the PO line for l10n_in.
    # ------------------------------------------------------------------
    product_id = fields.Many2one(
        'product.product', string='Raw Material Product',
        help='Stock-tracked product this receipt books into inventory once accepted. '
             'Defaults from the selected Species\' configured Raw Material Product.')

    line_ids = fields.One2many('aqua.catch.receipt.line', 'catch_receipt_id', string='Receipt Lines')

    state = fields.Selection([
        ('draft', 'Draft'),
        ('weighed', 'Weighed'),
        ('accepted', 'Accepted'),
        ('cancelled', 'Cancelled'),
    ], default='draft', tracking=True)

    processing_order_ids = fields.One2many('mrp.production', 'catch_receipt_id', string='Processing Orders')
    quality_test_ids = fields.One2many('aqua.quality.test', 'catch_receipt_id', string='QC Tests')

    processing_order_count = fields.Integer(compute='_compute_counts')
    quality_test_count = fields.Integer(compute='_compute_counts')

    _sql_constraints = [
        ('receipt_uniq', 'unique(vendor_id, receipt_date, species_id, company_id)',
         'A receipt already exists for this vendor/date/species/company.'),
    ]

    @api.constrains('gross_weight', 'net_weight')
    def _check_weights(self):
        for rec in self:
            if rec.net_weight and rec.gross_weight and rec.net_weight > rec.gross_weight:
                raise ValidationError('Net weight cannot exceed gross weight.')

    def _compute_counts(self):
        for rec in self:
            rec.processing_order_count = len(rec.processing_order_ids)
            rec.quality_test_count = len(rec.quality_test_ids)

    @api.onchange('vendor_id')
    def _onchange_vendor_id(self):
        if self.vendor_id:
            contract = self.env['aqua.vendor.rate.contract'].search([
                ('vendor_id', '=', self.vendor_id.id),
                ('active', '=', True),
            ], limit=1)
            if contract:
                self.rate_contract_id = contract

    @api.onchange('species_id')
    def _onchange_species_id(self):
        if self.species_id and not self.product_id:
            product = self._get_product(self.species_id, raise_if_missing=False)
            if product:
                self.product_id = product

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.catch.receipt') or 'New'
            vals.setdefault('state', 'draft')
        return super().create(vals_list)

    def write(self, vals):
        locked_fields = {'gross_weight', 'tare_weight', 'net_weight', 'line_ids'}
        for rec in self:
            if rec.state == 'accepted' and locked_fields.intersection(vals.keys()):
                raise UserError('Weighment/grading fields cannot be edited once the receipt is accepted.')
        return super().write(vals)

    def unlink(self):
        for rec in self:
            if rec.processing_order_ids:
                raise UserError('Cannot delete a catch receipt that has processing orders linked to it.')
        return super().unlink()

    def action_confirm_weighment(self):
        self.write({'state': 'weighed'})

    def action_accept(self):
        self.write({'state': 'accepted'})
        self._create_purchase_order()

    def _get_product(self, species, raise_if_missing=True):
        """Single lookup for the raw-material product linked to a species, sourced only
        from product.aqua_species_id (Product -> Species). This replaces two previously
        duplicated/conflicting mechanisms: a reverse species.raw_material_product_id field,
        and an unreachable aqua.generate.po.wizard that reimplemented this same search."""
        products = self.env['product.template'].search([('aqua_species_id', '=', species.id)])
        purchasable = products.filtered('purchase_ok')
        if len(purchasable) == 1:
            products = purchasable
        if not products:
            if raise_if_missing:
                raise UserError(
                    "No product is linked to species '%s'. Go to the Product form, "
                    "General Information tab, and set 'Aqua Species' to '%s'." % (species.name, species.name)
                )
            return False
        if len(products) > 1:
            if raise_if_missing:
                raise UserError(
                    "More than one purchasable product is linked to species '%s': %s. "
                    "Set the correct product manually, or make sure only one raw-material "
                    "product per species has 'Can be Purchased' checked." %
                    (species.name, ', '.join(products.mapped('name')))
                )
            return False
        return products.product_variant_id

    def _get_rate_fallback(self, rec):
        contract = self.env['aqua.vendor.rate.contract'].search([
            ('vendor_id', '=', rec.vendor_id.id),
            ('species_id', '=', rec.species_id.id),
            ('active', '=', True),
        ], limit=1)
        return contract.rate if contract else (rec.product_id.standard_price if rec.product_id else 0.0)

    def _create_purchase_order(self):
        """Create and confirm a real purchase.order for this receipt, so this Catch Receipt
        is backed by an actual Odoo procurement document instead of only a state flag.

        ------------------------------------------------------------------
        FIX: Previously built one PO line per aqua.catch.receipt.line grade
        split (line.grading_standard_id), i.e. size grade was declared at
        intake. Per the confirmed business process (aqua_by_m.docx), size
        grading only happens during the Grading Work Order, roughly the
        4th of 5 processing operations -- well after Cleaning, Peeling &
        Deveining and Freezing. The raw material arrives and is purchased
        as a single ungraded quantity identified only by its species/count
        spec (e.g. "c50"), not by size. Declaring a grade split here was
        the same mistake as choosing a graded finished product at MO
        creation: both assume information that doesn't exist yet.
        This now always creates a single ungraded PO line from net_weight.
        aqua.catch.receipt.line / grading_standard_id are left in place as
        a model (still useful as master data for the Grading/Packing
        stage bands) but are no longer read here.
        ------------------------------------------------------------------
        """
        for rec in self:
            if rec.purchase_order_id:
                continue
            product = rec.product_id or rec._get_product(rec.species_id, raise_if_missing=False)
            if not product:
                rec.message_post(
                    body='Purchase Order not created automatically: no product is linked to '
                         'Species "%s". Set Product > General Information > Aqua Species, or set '
                         'the Raw Material Product on this receipt directly, then use "Create '
                         'Purchase Order" manually.' % rec.species_id.name)
                continue
            if not rec.net_weight:
                rec.message_post(body='Purchase Order not created automatically: Net Weight is zero.')
                continue

            rate = rec.rate_contract_id.rate if rec.rate_contract_id else rec._get_rate_fallback(rec)
            po_uom = product.uom_po_id or product.uom_id

            purchase_order = self.env['purchase.order'].create({
                'partner_id': rec.vendor_id.id,
                'origin': rec.name,
                'company_id': rec.company_id.id,
                'order_line': [(0, 0, {
                    'product_id': product.id,
                    'name': product.display_name,
                    'product_qty': rec.net_weight,
                    'product_uom': po_uom.id,
                    'price_unit': rate,
                })],
            })
            purchase_order.button_confirm()
            rec.purchase_order_id = purchase_order.id
            rec.message_post(
                body=f'Purchase Order {purchase_order.name} created and confirmed. '
                     f'Complete the Receive / Quality Control / Store transfers from the '
                     f'Purchase Order to bring this catch into usable stock.')

    def action_view_purchase_order(self):
        self.ensure_one()
        if not self.purchase_order_id:
            raise UserError('No Purchase Order is linked to this receipt yet.')
        return {
            'type': 'ir.actions.act_window', 'name': 'Purchase Order',
            'res_model': 'purchase.order', 'view_mode': 'form',
            'res_id': self.purchase_order_id.id,
        }

    def action_reset_to_draft(self):
        for rec in self:
            if rec.state not in ('accepted', 'cancelled'):
                raise UserError('Only an Accepted or Cancelled receipt can be reset to draft.')
        self.write({'state': 'draft'})

    def action_view_processing_orders(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Processing Orders',
            'res_model': 'mrp.production',
            'view_mode': 'list,form',
            'domain': [('catch_receipt_id', '=', self.id)],
        }

    def action_view_quality_tests(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'QC Tests',
            'res_model': 'aqua.quality.test',
            'view_mode': 'list,form',
            'domain': [('catch_receipt_id', '=', self.id)],
        }


class AquaCatchReceiptLine(models.Model):
    _name = 'aqua.catch.receipt.line'
    _description = 'Catch Receipt Line (Grade-wise Split)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True, ondelete='cascade')
    grading_standard_id = fields.Many2one('aqua.grading.standard', string='Grade')
    quantity = fields.Float(string='Quantity (kg)')
    lot_id = fields.Many2one('stock.lot', string='Stock Lot')