from odoo import api, fields, models
from odoo.exceptions import ValidationError


class AquaGradingStandard(models.Model):
    _name = 'aqua.grading.standard'
    _description = 'Aqua Grading Standard / Band'
    _order = 'species_id, min_weight'

    name = fields.Char(required=True, help='e.g. Large, Medium, Small')
    species_id = fields.Many2one('aqua.species', required=True, ondelete='cascade')
    min_weight = fields.Float(string='Min Weight (g)', required=True)
    max_weight = fields.Float(string='Max Weight (g)', required=True)
    quality_criteria = fields.Text()
    active = fields.Boolean(default=True)

    @api.constrains('min_weight', 'max_weight')
    def _check_weight_band(self):
        for rec in self:
            if rec.min_weight >= rec.max_weight:
                raise ValidationError('Min weight must be less than max weight.')
