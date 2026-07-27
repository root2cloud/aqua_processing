from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class AquaShipment(models.Model):
    _name = 'aqua.shipment'
    _description = 'Export/Domestic Shipment'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'create_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    customer_id = fields.Many2one('res.partner', string='Customer', required=True)
    sale_order_id = fields.Many2one('sale.order', string='Sale Order')
    incoterm = fields.Char()
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    pallet_ids = fields.One2many('aqua.pallet', 'shipment_id', string='Pallets')
    container_id = fields.Many2one('aqua.container', string='Container')
    export_document_ids = fields.One2many('aqua.export.document', 'shipment_id', string='Documents')
    certificate_ids = fields.One2many('aqua.certificate.of.analysis', 'shipment_id', string='Certificates')
    trace_link_ids = fields.One2many('aqua.trace.link', 'shipment_id', string='Traceability Records')

    # India Compliance
    fssai_ref = fields.Char(string='FSSAI Reference')
    mpeda_ref = fields.Char(string='MPEDA Reference')
    eic_ref = fields.Char(string='EIC Reference')
    gstin = fields.Char(string='GSTIN')
    hsn_code = fields.Char(string='HSN Code')
    iec_code = fields.Char(string='IEC Code')

    etd = fields.Date(string='ETD')
    eta = fields.Date(string='ETA')

    state = fields.Selection([
        ('booked', 'Booked'), ('stuffed', 'Stuffed'),
        ('dispatched', 'Dispatched'), ('delivered', 'Delivered'),
    ], default='booked', tracking=True)

    container_count = fields.Integer(compute='_compute_counts')
    document_count = fields.Integer(compute='_compute_counts')
    document_complete_count = fields.Integer(compute='_compute_counts')

    def _compute_counts(self):
        for rec in self:
            rec.container_count = 1 if rec.container_id else 0
            rec.document_count = len(rec.export_document_ids)
            rec.document_complete_count = len(rec.export_document_ids.filtered(lambda d: d.state == 'final'))

    @api.constrains('state')
    def _check_dispatch_requires_certificate(self):
        for rec in self:
            if rec.state == 'dispatched' and not rec.certificate_ids:
                raise ValidationError('A shipment cannot be dispatched without at least one Certificate of Analysis.')

    def write(self, vals):
        for rec in self:
            if rec.state == 'dispatched' and 'container_id' in vals:
                raise UserError('Container assignment cannot be changed once the shipment is dispatched.')
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.shipment') or 'New'
        return super().create(vals_list)

    def action_book(self):
        self.write({'state': 'booked'})

    def action_stuff(self):
        self.write({'state': 'stuffed'})

    def action_dispatch(self):
        self.write({'state': 'dispatched'})

    def action_deliver(self):
        self.write({'state': 'delivered'})

    def action_reset_to_draft(self):
        for rec in self:
            if rec.state != 'stuffed':
                raise UserError('Only a Stuffed shipment can be reset to Booked.')
            if rec.state in ('dispatched', 'delivered') or rec.export_document_ids.filtered(lambda d: d.state == 'final'):
                raise UserError('Cannot reset a Dispatched/Delivered shipment or one with filed export documents.')
        self.write({'state': 'booked'})

    def action_view_containers(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Containers',
            'res_model': 'aqua.container', 'view_mode': 'list,form',
            'domain': [('id', '=', self.container_id.id)],
        }

    def action_view_documents(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Documents',
            'res_model': 'aqua.export.document', 'view_mode': 'list,form',
            'domain': [('shipment_id', '=', self.id)],
        }

    def action_view_traceability_summary(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Traceability Summary',
            'res_model': 'aqua.trace.link', 'view_mode': 'list,form',
            'domain': [('shipment_id', '=', self.id)],
        }

    def action_create_sale_order(self):
        """Auto-generate the Sale Order from what's actually been packed onto this
        shipment's pallets, instead of requiring the user to create it manually
        in the Sales app and link it back by hand."""
        self.ensure_one()
        if self.sale_order_id:
            raise UserError('A Sale Order is already linked to this shipment: %s' % self.sale_order_id.name)
        if not self.customer_id:
            raise UserError('Set a Customer on the shipment before creating a Sale Order.')

        cartons = self.pallet_ids.mapped('carton_ids')
        if not cartons:
            raise UserError('No cartons are loaded on this shipment yet. Load pallets/cartons first.')

        # Group carton weight by the finished-goods product coming from each
        # carton's processing order, since cartons themselves don't store product/lot.
        qty_by_product = {}
        for carton in cartons:
            production = carton.pack_order_id.processing_order_id
            product = production.product_id
            if not product:
                raise UserError(
                    "Carton '%s' traces back to a processing order with no finished product set. "
                    "Fix the Processing Order before creating the Sale Order." % carton.name
                )
            qty_by_product[product] = qty_by_product.get(product, 0.0) + carton.total_weight

        order_lines = [(0, 0, {
            'product_id': product.id,
            'product_uom_qty': qty,
            'product_uom': product.uom_id.id,
            'price_unit': product.list_price,
        }) for product, qty in qty_by_product.items()]

        sale_order = self.env['sale.order'].create({
            'partner_id': self.customer_id.id,
            'origin': self.name,
            'order_line': order_lines,
        })
        self.sale_order_id = sale_order.id
        return {'type': 'ir.actions.act_window', 'name': 'Sale Order',
                'res_model': 'sale.order', 'view_mode': 'form', 'res_id': sale_order.id}


class AquaContainer(models.Model):
    _name = 'aqua.container'
    _description = 'Export Container'

    name = fields.Char(required=True)
    container_number = fields.Char()
    container_type = fields.Selection([
        ('reefer_20', "20' Reefer"), ('reefer_40', "40' Reefer"), ('dry_20', "20' Dry"), ('dry_40', "40' Dry"),
    ], required=True)
    max_weight_kg = fields.Float()
    max_volume_cbm = fields.Float()
    shipment_ids = fields.One2many('aqua.shipment', 'container_id', string='Shipments')


class AquaExportDocument(models.Model):
    _name = 'aqua.export.document'
    _description = 'Export Document'

    name = fields.Char(required=True)
    shipment_id = fields.Many2one('aqua.shipment', required=True, ondelete='cascade')
    document_type = fields.Selection([
        ('health_certificate', 'Health Certificate (EIC)'),
        ('coa', 'Certificate of Analysis'),
        ('packing_list', 'Packing List'),
        ('invoice', 'Commercial Invoice'),
        ('bill_of_lading', 'Bill of Lading'),
        ('certificate_of_origin', 'Certificate of Origin'),
        ('mpeda_certificate', 'MPEDA Certificate'),
    ], required=True)
    state = fields.Selection([('draft', 'Draft'), ('final', 'Final')], default='draft')
    attachment_id = fields.Many2one('ir.attachment')