from odoo import api, fields, models


class AquaSpecies(models.Model):
    _name = 'aqua.species'
    _description = 'Aqua Species Master'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'name'

    name = fields.Char(required=True, index=True)
    code = fields.Char()
    category = fields.Selection([
        ('fish', 'Fish'),
        ('shrimp', 'Shrimp'),
        ('crab', 'Crab'),
        ('lobster', 'Lobster'),
        ('squid', 'Squid'),
        ('mollusk', 'Mollusk'),
        ('other', 'Other'),
    ], required=True, default='fish')
    region = fields.Char(help='Typical source region/water body')
    scientific_name = fields.Char()
    image = fields.Image()
    nutritional_info = fields.Text()
    active = fields.Boolean(default=True)
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    grading_standard_ids = fields.One2many('aqua.grading.standard', 'species_id', string='Grading Bands')
    harvest_method_ids = fields.Many2many('aqua.harvest.method', string='Harvest Methods')

    # ------------------------------------------------------------------
    # NOTE: the one-way link to a purchasable raw-material product lives on
    # product.template.aqua_species_id (Product -> Species) -- that remains
    # the single stored source of truth. product_tmpl_id below is a
    # non-stored convenience field so a species can be created/edited by
    # picking an existing Product instead of free-typing the Species Name;
    # its inverse writes back to the one real field on the product side,
    # so no duplicate/conflicting link is (re)introduced.
    # ------------------------------------------------------------------
    product_tmpl_id = fields.Many2one(
        'product.template', string='Species', store=False,
        compute='_compute_product_tmpl_id', inverse='_inverse_product_tmpl_id',
        help='Select the existing stock/purchase product this species represents '
             '(e.g. "Raw Shrimp"). This species\' Name is derived automatically from it.')

    def _compute_product_tmpl_id(self):
        for rec in self:
            rec.product_tmpl_id = self.env['product.template'].search(
                [('aqua_species_id', '=', rec.id)], limit=1) if rec.id else False

    def _inverse_product_tmpl_id(self):
        for rec in self:
            linked = self.env['product.template'].search([('aqua_species_id', '=', rec.id)])
            (linked - rec.product_tmpl_id).write({'aqua_species_id': False})
            if rec.product_tmpl_id:
                rec.product_tmpl_id.aqua_species_id = rec.id
                rec.name = rec.product_tmpl_id.name

    @api.onchange('product_tmpl_id')
    def _onchange_product_tmpl_id(self):
        if self.product_tmpl_id:
            self.name = self.product_tmpl_id.name

    grading_standard_count = fields.Integer(compute='_compute_grading_standard_count', store=True)
    vendor_count = fields.Integer(compute='_compute_vendor_count')

    _sql_constraints = [
        ('name_uniq', 'unique(name)', 'Species name must be unique'),
    ]

    @api.depends('grading_standard_ids')
    def _compute_grading_standard_count(self):
        for rec in self:
            rec.grading_standard_count = len(rec.grading_standard_ids)

    def _compute_vendor_count(self):
        for rec in self:
            rec.vendor_count = self.env['aqua.catch.receipt'].search_count(
                [('species_id', '=', rec.id)]
            ) if 'aqua.catch.receipt' in self.env else 0

    def action_view_grading_standards(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Grading Bands',
            'res_model': 'aqua.grading.standard',
            'view_mode': 'list,form',
            'domain': [('species_id', '=', self.id)],
        }

    def action_view_vendors(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': 'Vendors Supplying',
            'res_model': 'aqua.catch.receipt',
            'view_mode': 'list,form',
            'domain': [('species_id', '=', self.id)],
        }