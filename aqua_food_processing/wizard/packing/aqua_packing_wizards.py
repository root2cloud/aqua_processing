from odoo import fields, models


class AquaBuildCartonWizard(models.TransientModel):
    _name = 'aqua.build.carton.wizard'
    _description = 'Build Carton Wizard'

    pack_order_id = fields.Many2one('aqua.pack.order', required=True)
    total_weight = fields.Float(string='Total Weight (kg)', required=True)
    barcode = fields.Char()

    def action_confirm(self):
        self.ensure_one()
        return self.env['aqua.carton'].create({
            'pack_order_id': self.pack_order_id.id,
            'total_weight': self.total_weight,
            'barcode': self.barcode,
        })


class AquaBuildPalletWizard(models.TransientModel):
    _name = 'aqua.build.pallet.wizard'
    _description = 'Build Pallet Wizard'

    carton_ids = fields.Many2many('aqua.carton', required=True)

    def action_confirm(self):
        self.ensure_one()
        pallet = self.env['aqua.pallet'].create({})
        self.carton_ids.write({'pallet_id': pallet.id})
        return {
            'type': 'ir.actions.act_window', 'name': 'Pallet',
            'res_model': 'aqua.pallet', 'view_mode': 'form', 'res_id': pallet.id,
        }


class AquaPrintLabelsWizard(models.TransientModel):
    _name = 'aqua.print.labels.wizard'
    _description = 'Print Labels Wizard'

    carton_ids = fields.Many2many('aqua.carton')
    label_template_id = fields.Many2one('aqua.label.template', required=True)

    def action_print(self):
        self.ensure_one()
        report = self.env.ref('aqua_food_processing.action_report_aqua_carton_label', raise_if_not_found=False)
        if report:
            return report.report_action(self.carton_ids)
        return True
