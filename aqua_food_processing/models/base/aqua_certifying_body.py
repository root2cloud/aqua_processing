from odoo import fields, models


class AquaCertifyingBody(models.Model):
    _name = 'aqua.certifying.body'
    _description = 'Certifying / Regulatory Body (FSSAI, MPEDA, EIC, MSC, ASC...)'
    _order = 'name'

    name = fields.Char(required=True)
    code = fields.Char()
    certificate_type_ids = fields.Char(string='Certificate Types Issued',
                                        help='Comma-separated list, e.g. Health Certificate, COA')
    country = fields.Char(default='India')
    active = fields.Boolean(default=True)
