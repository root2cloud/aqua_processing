from odoo import fields, models
from odoo.exceptions import UserError


class AquaStuffContainerWizard(models.TransientModel):
    _name = 'aqua.stuff.container.wizard'
    _description = 'Stuff Container Wizard'

    shipment_id = fields.Many2one('aqua.shipment', required=True)
    container_id = fields.Many2one('aqua.container', required=True)
    pallet_ids = fields.Many2many('aqua.pallet', required=True)

    def action_confirm(self):
        self.ensure_one()
        total_weight = sum(self.pallet_ids.mapped('gross_weight'))
        if self.container_id.max_weight_kg and total_weight > self.container_id.max_weight_kg:
            raise UserError('Total pallet weight exceeds the container\'s maximum weight limit.')
        self.pallet_ids.write({'shipment_id': self.shipment_id.id, 'state': 'loaded'})
        self.shipment_id.write({'container_id': self.container_id.id})
        self.shipment_id.action_stuff()


class AquaGenerateExportDocumentSetWizard(models.TransientModel):
    _name = 'aqua.generate.export.document.set.wizard'
    _description = 'Generate Export Document Set Wizard'

    shipment_id = fields.Many2one('aqua.shipment', required=True)

    def action_generate(self):
        self.ensure_one()
        doc_types = ['health_certificate', 'coa', 'packing_list', 'invoice',
                     'bill_of_lading', 'certificate_of_origin', 'mpeda_certificate']
        for doc_type in doc_types:
            if not self.shipment_id.export_document_ids.filtered(lambda d: d.document_type == doc_type):
                self.env['aqua.export.document'].create({
                    'name': f'{dict(self.env["aqua.export.document"]._fields["document_type"].selection).get(doc_type)} - {self.shipment_id.name}',
                    'shipment_id': self.shipment_id.id,
                    'document_type': doc_type,
                })


class AquaMarkDispatchedWizard(models.TransientModel):
    _name = 'aqua.mark.dispatched.wizard'
    _description = 'Mark as Dispatched Wizard'

    shipment_id = fields.Many2one('aqua.shipment', required=True)
    dispatch_date = fields.Date(default=fields.Date.context_today)

    def action_confirm(self):
        self.ensure_one()
        self.shipment_id.action_dispatch()
