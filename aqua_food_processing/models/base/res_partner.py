from odoo import fields, models


class ResPartner(models.Model):
    _inherit = 'res.partner'

    is_aqua_vendor = fields.Boolean(string='Aqua Vendor / Harvester')
    aqua_vendor_rating = fields.Selection([
        ('1', 'Poor'), ('2', 'Fair'), ('3', 'Good'), ('4', 'Very Good'), ('5', 'Excellent'),
    ], string='Vendor Rating')
    fssai_license_no = fields.Char(string='FSSAI License No.')
    aqua_certification = fields.Selection([
        ('msc', 'MSC'), ('asc', 'ASC'), ('both', 'MSC & ASC'), ('none', 'None'),
    ], string='Certification', default='none')
    aqua_region = fields.Char(string='Region')