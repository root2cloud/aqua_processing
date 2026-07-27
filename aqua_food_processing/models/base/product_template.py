from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    aqua_species_id = fields.Many2one('aqua.species', string='Aqua Species')
    aqua_form = fields.Selection([
        ('whole', 'Whole'),
        ('fillet', 'Fillet'),
        ('peeled', 'Peeled'),
        ('deveined', 'Peeled & Deveined'),
        ('iqf', 'IQF'),
        ('other', 'Other'),
    ], string='Product Form')