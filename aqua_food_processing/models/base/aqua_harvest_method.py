from odoo import fields, models


class AquaHarvestMethod(models.Model):
    _name = 'aqua.harvest.method'
    _description = 'Aqua Harvest Method'
    _order = 'name'

    name = fields.Char(required=True)
    code = fields.Char(required=True)
    description = fields.Text()
    species_ids = fields.Many2many('aqua.species', string='Applicable Species')
    active = fields.Boolean(default=True)

    _sql_constraints = [
        ('code_uniq', 'unique(code)', 'Harvest method code must be unique'),
    ]
