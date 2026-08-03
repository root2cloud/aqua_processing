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
    purchase_order_id = fields.Many2one('purchase.order', string='Purchase Order',
        help='Set automatically by "Create Purchase Order" below, or pick an existing, '
             'already-confirmed Purchase Order if one was created elsewhere.')
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
    # Vendor-reported count: the vendor enters this on the RFQ portal
    # (purchase.order.line.shrimp_count) before the catch ever arrives.
    # Surfaced here read-only so the factory's own count above (from the
    # physical sample) can be checked against what the vendor claimed.
    # A catch receipt's PO normally carries a single product line for the
    # species being received, so the first order line is used.
    # ------------------------------------------------------------------
    vendor_shrimp_count = fields.Integer(string='Vendor Reported Count',
        compute='_compute_vendor_shrimp_count',
        help='Shrimp count (per kg) the vendor reported on the RFQ portal, for comparison against the count taken on arrival.')

    @api.depends('purchase_order_id', 'purchase_order_id.order_line.shrimp_count')
    def _compute_vendor_shrimp_count(self):
        for rec in self:
            line = rec.purchase_order_id.order_line.filtered(lambda l: not l.display_type)[:1]
            rec.vendor_shrimp_count = line.shrimp_count if line else 0

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
        help='Mirrors the names of every delivery\'s Batch Transfer (stock.picking.batch), '
             'comma-separated in delivery order (e.g. "BATCH/00034, BATCH/00035, BATCH/00036, '
             'BATCH/00037" for a 4-delivery receipt). See the "Deliveries" tab for which batch '
             'belongs to which specific delivery.')
    # Same data as batch_number above, but a real Many2many instead of a comma-joined Char --
    # so the list/form views can render it as compact, colored tag chips (widget=
    # "many2many_tags") instead of one long, easily-truncated string. A Char field can't use
    # that widget, which is why both forms exist side by side.
    batch_ids = fields.Many2many('stock.picking.batch', string='Batches',
        compute='_compute_batch_number', store=True)

    @api.depends('purchase_order_id.picking_ids.batch_id.name', 'purchase_order_id.picking_ids.scheduled_date')
    def _compute_batch_number(self):
        for rec in self:
            pickings = rec.purchase_order_id.picking_ids.filtered(
                lambda p: p.picking_type_id.code == 'incoming').sorted('scheduled_date')
            names = [b for b in pickings.mapped('batch_id.name') if b]
            rec.batch_number = ', '.join(names) or False
            rec.batch_ids = [(6, 0, pickings.batch_id.ids)]

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
        help='Mirrors the Lot/Serial Number of every delivery, comma-separated in delivery '
             'order (e.g. "sayugs, sdga, sdkyusa, dsayugsa" for a 4-delivery receipt). See the '
             '"Deliveries" tab for which lot belongs to which specific delivery.')
    # Same data as lot_number above, but a real Many2many for tag-chip display -- see the
    # comment on batch_ids above for why both a Char and a Many2many exist side by side.
    lot_ids = fields.Many2many('stock.lot', string='Lots/Serials',
        compute='_compute_lot_number', store=True)

    @api.depends('purchase_order_id.picking_ids.move_line_ids.lot_id.name',
                 'purchase_order_id.picking_ids.scheduled_date', 'product_id', 'species_id')
    def _compute_lot_number(self):
        for rec in self:
            product = rec.product_id or rec._get_product(rec.species_id, raise_if_missing=False)
            pickings = rec.purchase_order_id.picking_ids.filtered(
                lambda p: p.picking_type_id.code == 'incoming').sorted('scheduled_date')
            lots = self.env['stock.lot']
            names = []
            for picking in pickings:
                move_lines = picking.move_line_ids.filtered(
                    lambda ml: product and ml.product_id == product and ml.lot_id)
                names += [n for n in move_lines.mapped('lot_id.name') if n]
                lots |= move_lines.lot_id
            # de-dupe while preserving order
            seen = set()
            ordered = [n for n in names if not (n in seen or seen.add(n))]
            rec.lot_number = ', '.join(ordered) or False
            rec.lot_ids = [(6, 0, lots.ids)]

    # ------------------------------------------------------------------
    # Deliveries: a single PO/Catch Receipt is frequently fulfilled by the
    # vendor across more than one physical arrival (the total ordered
    # quantity shows up in batches over hours/days, not all at once), and
    # -- per your confirmation -- EACH of those arrivals gets its own
    # Weighment and Shrimp Counting done at the gate, just like the very
    # first one above. Odoo already models each arrival as its own
    # Incoming Transfer (stock.picking), chained as backorders of one
    # another, each optionally grouped into its own Batch Transfer with
    # its own Lot/Serial Number.
    #
    # delivery_ids is a genuine stored table (aqua.catch.receipt.delivery)
    # -- one row per Incoming Transfer -- where Weighment/Shrimp Counting
    # for deliveries after the first are entered directly on that row.
    # IMPORTANT: unlike the old version, this is NOT a fully-recomputed
    # field anymore. It used to be a `compute` field that cleared and
    # rebuilt every row from scratch on every change -- which would have
    # silently wiped out any Gross/Tare/Net Weight or Shrimp Counting a
    # user had typed into a delivery row the moment anything else on the
    # PO's pickings changed. It's now a normal relation: action_sync_
    # deliveries() (button "Update Deliveries", also called automatically
    # right after the Purchase Order is created) only ADDS a row for any
    # Incoming Transfer that doesn't have one yet -- it never touches or
    # removes an existing row, so manually entered data is always safe.
    # ------------------------------------------------------------------
    delivery_ids = fields.One2many('aqua.catch.receipt.delivery', 'catch_receipt_id', string='Deliveries')
    delivery_count = fields.Integer(string='Delivery Count', compute='_compute_delivery_totals', store=True)
    total_received = fields.Float(string='Total Received (kg)', compute='_compute_delivery_totals',
        store=True,
        help='Sum of the quantities received across all Done deliveries so far.')

    @api.depends('delivery_ids.quantity', 'delivery_ids.state')
    def _compute_delivery_totals(self):
        for rec in self:
            rec.delivery_count = len(rec.delivery_ids)
            rec.total_received = sum(rec.delivery_ids.filtered(lambda d: d.state == 'done').mapped('quantity'))

    def action_sync_deliveries(self):
        """Add a Deliveries row for any Incoming Transfer on this receipt's Purchase Order that
        doesn't have one yet. Purely additive -- never edits or removes an existing row, so any
        Weighment/Shrimp Counting already entered on a delivery is never touched.

        Exception: the FIRST delivery's picking gets the header's own Weighment/Shrimp Counting
        (taken before the PO/picking existed) copied onto it once, so it isn't left blank on the
        actual receipt screen -- but only if that picking doesn't already have its own values."""
        for rec in self:
            if not rec.purchase_order_id:
                continue
            pickings = rec.purchase_order_id.picking_ids.filtered(
                lambda p: p.picking_type_id.code == 'incoming').sorted('scheduled_date')
            existing = {d.picking_id.id: d for d in rec.delivery_ids}
            for seq, picking in enumerate(pickings, start=1):
                if picking.id in existing:
                    if existing[picking.id].sequence != seq:
                        existing[picking.id].sequence = seq
                else:
                    self.env['aqua.catch.receipt.delivery'].create({
                        'catch_receipt_id': rec.id,
                        'sequence': seq,
                        'picking_id': picking.id,
                    })
                if seq == 1 and not picking.aqua_gross_weight and not picking.aqua_sample_count:
                    picking.write({
                        'aqua_gross_weight': rec.gross_weight,
                        'aqua_tare_weight': rec.tare_weight,
                        'aqua_net_weight': rec.net_weight,
                        'aqua_sample_weight': rec.sample_weight,
                        'aqua_sample_count': rec.sample_count,
                    })

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

    # ------------------------------------------------------------------
    # FIX: Draft -> Weighed -> Accepted used to be a manual 3-click state
    # machine, where "Accept" was the trigger that created the Purchase
    # Order from this receipt's own weighment. Since your actual process
    # is the other way around -- you create and confirm the PO in
    # Purchase first, THEN this receipt gets linked to it (purchase_
    # order_id is now required, see above) -- clicking through those 3
    # states did nothing real anymore: _create_purchase_order() always
    # skipped itself the moment a PO was already linked, so "Accept" was
    # just relabelling a status pill.
    #
    # state is now computed, not clicked: it reflects whether every
    # delivery this PO is expecting has actually arrived
    # (total_received >= ordered_qty) or not, straight from the
    # Deliveries tab -- nothing to remember to press. "Cancelled" is the
    # one case that still needs a person's judgment call (the whole
    # receipt is void, e.g. an order was scrapped), so that stays a
    # manual action (action_cancel / action_reopen below), stored
    # separately in `cancelled` so it isn't overwritten by the automatic
    # open/completed recompute.
    # ------------------------------------------------------------------
    cancelled = fields.Boolean(default=False, copy=False)
    ordered_qty = fields.Float(string='Ordered Quantity (kg)', compute='_compute_ordered_qty', store=True,
        help='Quantity on the linked Purchase Order\'s line for this receipt\'s product.')
    state = fields.Selection([
        ('open', 'Open'),
        ('completed', 'Completed'),
        ('cancelled', 'Cancelled'),
    ], default='open', compute='_compute_state', store=True, tracking=True)

    @api.depends('purchase_order_id.order_line.product_qty', 'purchase_order_id.order_line.product_id', 'product_id')
    def _compute_ordered_qty(self):
        for rec in self:
            product = rec.product_id or rec._get_product(rec.species_id, raise_if_missing=False)
            lines = rec.purchase_order_id.order_line.filtered(
                lambda l: not l.display_type and (not product or l.product_id == product))
            rec.ordered_qty = sum(lines.mapped('product_qty'))

    @api.depends('cancelled', 'total_received', 'ordered_qty', 'purchase_order_id')
    def _compute_state(self):
        for rec in self:
            if rec.cancelled:
                rec.state = 'cancelled'
            elif rec.purchase_order_id and rec.ordered_qty and rec.total_received >= rec.ordered_qty:
                rec.state = 'completed'
            else:
                rec.state = 'open'

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
        records = super().create(vals_list)
        records.filtered('purchase_order_id').action_sync_deliveries()
        return records

    # ------------------------------------------------------------------
    # FIX: action_sync_deliveries() was previously only ever called from
    # the two wizards (AquaWeighmentEntryWizard / AquaCreatePoWizard) --
    # i.e. only when the Purchase Order was created FROM this Catch
    # Receipt via the "Create Purchase Order" button. The Many2one help
    # text explicitly also allows "pick an existing, already-confirmed
    # Purchase Order if one was created elsewhere" (as shown in the UI:
    # picking P00044 from the dropdown), but doing that never triggered
    # a sync -- Deliveries stayed empty and Total Received/Delivery
    # Count stayed at 0 even though the linked PO's Receipt already had
    # real, validated transfers with quantities on them. The user had to
    # know to separately click "Update Deliveries" by hand, with nothing
    # telling them that step was needed.
    #
    # Now, writing purchase_order_id (from the form, an import, or code)
    # automatically runs the same sync the wizards already relied on, so
    # linking to an existing PO behaves the same as creating one via the
    # wizard. This does not remove the manual "Update Deliveries" button
    # -- it's still needed to pick up NEW backorders/deliveries created
    # in Inventory after the initial link, since nothing here hooks into
    # stock.picking creation itself.
    # ------------------------------------------------------------------
    def write(self, vals):
        res = super().write(vals)
        if vals.get('purchase_order_id'):
            self.filtered('purchase_order_id').action_sync_deliveries()
        return res

    def unlink(self):
        for rec in self:
            if rec.processing_order_ids:
                raise UserError('Cannot delete a catch receipt that has processing orders linked to it.')
        return super().unlink()

    def action_cancel(self):
        self.write({'cancelled': True})

    def action_reopen(self):
        self.write({'cancelled': False})

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

    def action_open_create_po_wizard(self):
        """Opens a small wizard to create+confirm a Purchase Order for this receipt, without
        ever leaving Aqua Processing or touching the generic Many2one "Create" dialog on
        purchase_order_id (that dialog's "open full form" link is what caused the
        "Invalid fields: Purchase Order" error -- it detaches the new PO from this receipt if
        this receipt isn't saved yet). This button auto-saves the receipt first if needed
        (standard Odoo behavior for an object-type button), then the wizard writes the new
        PO's id back onto this specific, already-saved record -- so that failure mode can't
        happen here."""
        self.ensure_one()
        if self.purchase_order_id:
            raise UserError('This receipt is already linked to Purchase Order %s.' % self.purchase_order_id.name)
        product = self.product_id or self._get_product(self.species_id, raise_if_missing=False)
        rate = self.rate_contract_id.rate if self.rate_contract_id else (
            product.standard_price if product else 0.0)
        return {
            'type': 'ir.actions.act_window',
            'name': 'Create Purchase Order',
            'res_model': 'aqua.create.po.wizard',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'default_catch_receipt_id': self.id,
                'default_vendor_id': self.vendor_id.id,
                'default_product_id': product.id if product else False,
                'default_price_unit': rate,
            },
        }

    def action_view_purchase_order(self):
        self.ensure_one()
        if not self.purchase_order_id:
            raise UserError('No Purchase Order is linked to this receipt yet.')
        return {
            'type': 'ir.actions.act_window', 'name': 'Purchase Order',
            'res_model': 'purchase.order', 'view_mode': 'form',
            'res_id': self.purchase_order_id.id,
        }

    def action_view_receipts(self):
        """Same idea as the "Receipt" smart button on the Purchase Order form itself -- opens
        the Incoming Transfers for this receipt's linked PO, straight from the Catch Receipt."""
        self.ensure_one()
        pickings = self.purchase_order_id.picking_ids
        action = {
            'type': 'ir.actions.act_window',
            'name': 'Receipts',
            'res_model': 'stock.picking',
            'domain': [('id', 'in', pickings.ids)],
        }
        if len(pickings) == 1:
            action.update(view_mode='form', res_id=pickings.id)
        else:
            action.update(view_mode='list,form')
        return action

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


class AquaCatchReceiptDelivery(models.Model):
    _name = 'aqua.catch.receipt.delivery'
    _description = 'Catch Receipt Delivery (one row per partial arrival/backorder)'
    _order = 'catch_receipt_id, sequence'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True, ondelete='cascade')
    sequence = fields.Integer(string='Delivery #', help='1 = first delivery received against this receipt\'s '
                               'Purchase Order, 2 = the next partial delivery (its backorder), and so on.')
    picking_id = fields.Many2one('stock.picking', string='Transfer', required=True, ondelete='cascade')

    # ------------------------------------------------------------------
    # Identity fields below (backorder_of_id, batch_id, lot_number,
    # quantity, state) only ever read from THIS row's own picking_id --
    # never from sibling rows or from the parent Catch Receipt's whole
    # picking set -- so recomputing one row can never disturb another
    # row's data, and none of them touch the manually entered Weighment/
    # Shrimp Counting fields further down.
    # ------------------------------------------------------------------
    backorder_of_id = fields.Many2one('stock.picking', string='Backorder Of',
        related='picking_id.backorder_id', store=True,
        help='The previous delivery this one is a backorder of. Blank for the first delivery.')
    batch_id = fields.Many2one('stock.picking.batch', string='Batch Transfer',
        related='picking_id.batch_id', store=True)
    state = fields.Selection(related='picking_id.state', store=True, string='Status')

    lot_number = fields.Char(string='Lot/Serial Number', compute='_compute_picking_data', store=True)
    quantity = fields.Float(string='Quantity Received (kg)', compute='_compute_picking_data', store=True)

    @api.depends('picking_id.move_line_ids.lot_id.name', 'picking_id.move_line_ids.quantity',
                 'picking_id.move_line_ids.product_id', 'catch_receipt_id.product_id',
                 'catch_receipt_id.species_id')
    def _compute_picking_data(self):
        for rec in self:
            cr = rec.catch_receipt_id
            product = cr.product_id or (cr._get_product(cr.species_id, raise_if_missing=False) if cr.species_id else False)
            move_lines = rec.picking_id.move_line_ids.filtered(lambda ml: product and ml.product_id == product)
            rec.lot_number = ', '.join(sorted(set(move_lines.mapped('lot_id.name')) - {False})) or False
            rec.quantity = sum(move_lines.mapped('quantity'))

    # ------------------------------------------------------------------
    # FIX: Weighment and Shrimp Counting used to live ONLY on this
    # aqua.catch.receipt.delivery row, meaning a warehouse user sitting on
    # the actual Incoming Transfer screen (Purchase > Receipt, e.g.
    # AQP/IN/00028) had no way to enter or even see them there -- they'd
    # have to go find the right Catch Receipt and its Deliveries tab
    # instead. Per your point, this belongs right on the receipt screen
    # itself, at the moment the truck is actually being weighed/counted.
    #
    # The real fields now live on stock.picking (see StockPicking below,
    # aqua_gross_weight etc.) and are shown directly on the Incoming
    # Transfer form. These fields here are `related` to that same record
    # (store=True so they still work in list/group-by/filters) -- so
    # there is exactly one place the data actually lives; entering it on
    # the Receipt screen or on this Deliveries tab updates the same
    # record either way, nothing to keep in sync manually.
    # ------------------------------------------------------------------
    gross_weight = fields.Float(string='Gross Weight (kg)', related='picking_id.aqua_gross_weight',
        store=True, readonly=False)
    tare_weight = fields.Float(string='Tare Weight (kg)', related='picking_id.aqua_tare_weight',
        store=True, readonly=False)
    net_weight = fields.Float(string='Net Weight (kg)', related='picking_id.aqua_net_weight',
        store=True, readonly=False)
    sample_weight = fields.Float(string='Sample Weight (kg)', related='picking_id.aqua_sample_weight',
        store=True, readonly=False,
        help='Total weight of the counted sample, in kg (e.g. 3 for 3 kg / 3000 g).')
    sample_count = fields.Integer(string='Shrimp Counted', related='picking_id.aqua_sample_count',
        store=True, readonly=False, help='Number of shrimp in that sample.')
    avg_body_weight = fields.Float(string='Average Body Weight (g)', related='picking_id.aqua_avg_body_weight',
        store=True, digits=(16, 2), help='(Sample Weight in kg x 1000) / Shrimp Counted.')
    shrimp_count = fields.Float(string='Count (per kg)', related='picking_id.aqua_shrimp_count',
        store=True, digits=(16, 1), help='1000 / Average Body Weight (g) -- how many shrimp make up one kilogram.')


class AquaCatchReceiptLine(models.Model):
    _name = 'aqua.catch.receipt.line'
    _description = 'Catch Receipt Line (Grade-wise Split)'

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', required=True, ondelete='cascade')
    grading_standard_id = fields.Many2one('aqua.grading.standard', string='Grade')
    quantity = fields.Float(string='Quantity (kg)')
    lot_id = fields.Many2one('stock.lot', string='Stock Lot')

class PurchaseOrderLine(models.Model):
    _inherit = 'purchase.order.line'

    shrimp_count = fields.Integer(
        string='Shrimp Count',
        help='Count per kg reported by the vendor for this line, filled in from the vendor portal.',
    )


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    # ------------------------------------------------------------------
    # Same fields/formulas as aqua.catch.receipt's header Weighment and
    # Shrimp Counting -- placed here too so they're right there on the
    # Incoming Transfer screen for EVERY delivery (not only the first),
    # at the point the truck is actually being weighed and counted.
    # aqua.catch.receipt.delivery.gross_weight etc. are `related` to
    # these, so filling them in here (or from the Catch Receipt's
    # Deliveries tab) is the same single record either way.
    #
    # FIX: copy=False on all of these. When you click Validate on a
    # partial delivery and choose "Create Backorder", Odoo creates that
    # backorder picking (AQP/IN/00031 etc.) internally via a `copy()` of
    # the picking you just validated (AQP/IN/00030) -- and by default
    # ANY custom field copies along with it unless told not to. Without
    # copy=False here, the backorder silently inherited delivery #1's
    # exact Gross/Tare/Net Weight and Shrimp Counting instead of starting
    # blank, which is exactly the "auto-filled, can't edit" symptom you
    # saw -- each delivery/trip weighs and counts separately, so each
    # backorder now always starts empty and has to be entered fresh.
    # ------------------------------------------------------------------
    aqua_gross_weight = fields.Float(string='Gross Weight (kg)', copy=False)
    aqua_tare_weight = fields.Float(string='Tare Weight (kg)', copy=False)
    aqua_net_weight = fields.Float(string='Net Weight (kg)', copy=False)

    @api.onchange('aqua_gross_weight', 'aqua_tare_weight')
    def _onchange_aqua_weighment(self):
        for rec in self:
            rec.aqua_net_weight = rec.aqua_gross_weight - rec.aqua_tare_weight

    aqua_sample_weight = fields.Float(string='Sample Weight (kg)', copy=False,
        help='Total weight of the counted sample, in kg (e.g. 3 for 3 kg / 3000 g).')
    aqua_sample_count = fields.Integer(string='Shrimp Counted', copy=False,
        help='Number of shrimp in that sample.')
    aqua_avg_body_weight = fields.Float(string='Average Body Weight (g)',
        compute='_compute_aqua_shrimp_count', store=True, copy=False, digits=(16, 2),
        help='(Sample Weight in kg x 1000) / Shrimp Counted.')
    aqua_shrimp_count = fields.Float(string='Count (per kg)',
        compute='_compute_aqua_shrimp_count', store=True, copy=False, digits=(16, 1),
        help='1000 / Average Body Weight (g) -- how many shrimp make up one kilogram.')

    @api.depends('aqua_sample_weight', 'aqua_sample_count')
    def _compute_aqua_shrimp_count(self):
        for rec in self:
            rec.aqua_avg_body_weight = (rec.aqua_sample_weight * 1000.0 / rec.aqua_sample_count) if rec.aqua_sample_count else 0.0
            rec.aqua_shrimp_count = (1000.0 / rec.aqua_avg_body_weight) if rec.aqua_avg_body_weight else 0.0


# ----------------------------------------------------------------------
# color fields below: the many2many_tags widget on batch_ids/lot_ids (see
# aqua.catch.receipt above) only colors each tag differently if its
# model has a 'color' field to pick from -- same mechanism CRM tags,
# Project tags, etc. use. Neither stock.picking.batch nor stock.lot ships
# with one, so without this the tags all render as flat, uncolored grey
# pills. This just derives a color index (0-10, Odoo's standard tag
# palette size) from the record's own id, so each batch/lot consistently
# gets its own color rather than a random one that changes on every
# screen refresh.
# ----------------------------------------------------------------------
class StockPickingBatch(models.Model):
    _inherit = 'stock.picking.batch'

    color = fields.Integer(string='Color', compute='_compute_color')

    def _compute_color(self):
        for rec in self:
            rec.color = (rec.id or 0) % 11


class StockLot(models.Model):
    _inherit = 'stock.lot'

    color = fields.Integer(string='Color', compute='_compute_color')

    def _compute_color(self):
        for rec in self:
            rec.color = (rec.id or 0) % 11