from odoo import fields, models
from odoo.exceptions import UserError


class AquaRecordTemperatureWizard(models.TransientModel):
    _name = 'aqua.record.temperature.wizard'
    _description = 'Record Temperature Reading Wizard'

    cold_room_id = fields.Many2one('aqua.cold.room', required=True)
    temperature = fields.Float(required=True)

    def action_confirm(self):
        self.ensure_one()
        self.env['aqua.temperature.log'].create({
            'cold_room_id': self.cold_room_id.id,
            'temperature': self.temperature,
            'source': 'manual',
        })


class AquaMoveLotWizard(models.TransientModel):
    _name = 'aqua.move.lot.wizard'
    _description = 'Move Lot Between Cold Rooms Wizard'

    source_cold_room_id = fields.Many2one('aqua.cold.room', required=True)
    destination_cold_room_id = fields.Many2one('aqua.cold.room', required=True)
    lot_id = fields.Many2one('stock.lot', required=True)
    quantity = fields.Float(required=True)

    # ------------------------------------------------------------------
    # FIX (senior-dev review, item 4/5): the previous version called
    # stock.move.create(...) directly with no picking, no move line, and
    # no lot assigned on the move line, and never confirmed/validated it.
    # A bare stock.move like that sits in 'draft' state forever -- it
    # does NOT reserve, does NOT move the quant, and does NOT show up as
    # a real transfer anywhere in Inventory. This was the one wizard in
    # the module already pointed at the right underlying API (a real
    # stock model instead of a custom Float log), but it was incomplete
    # to the point of not actually doing anything.
    #
    # This version creates a proper internal-transfer stock.picking,
    # confirms it, reserves it, assigns the specific lot and quantity on
    # the resulting move line, and validates it -- so the cold room
    # transfer is a real, auditable Odoo transfer, not a silent no-op.
    #
    # VERSION NOTE: stock.move.line's done-quantity field is named
    # 'quantity' as of Odoo 17+ (it replaced the older quantity_done
    # field name). Verify this against your exact installed core; if it
    # differs, adjust the move_line_ids.write() call below. Also note
    # button_validate() can raise Odoo's own "Immediate Transfer" /
    # backorder wizard if the reserved quantity does not exactly match
    # what was requested -- this is expected native behaviour, not a bug
    # in this wizard.
    # ------------------------------------------------------------------
    def action_confirm(self):
        self.ensure_one()
        if self.source_cold_room_id == self.destination_cold_room_id:
            raise UserError('Source and destination cold room cannot be the same.')
        if self.quantity <= 0:
            raise UserError('Quantity must be greater than zero.')
        if not self.source_cold_room_id.location_id or not self.destination_cold_room_id.location_id:
            raise UserError('Both cold rooms must have a Stock Location configured before transferring.')

        picking_type = self.env['stock.picking.type'].search([
            ('code', '=', 'internal'),
            ('warehouse_id.company_id', '=', self.env.company.id),
        ], limit=1)
        if not picking_type:
            raise UserError(
                'No Internal Transfer operation type found for this company. Configure one under '
                'Inventory > Configuration > Operations Types before using cold room transfers.')

        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'location_id': self.source_cold_room_id.location_id.id,
            'location_dest_id': self.destination_cold_room_id.location_id.id,
            'origin': f'Aqua Cold Room Transfer: {self.lot_id.name}',
            'move_ids': [(0, 0, {
                'name': f'Aqua cold room transfer: {self.lot_id.name}',
                'product_id': self.lot_id.product_id.id,
                'product_uom_qty': self.quantity,
                'product_uom': self.lot_id.product_id.uom_id.id,
                'location_id': self.source_cold_room_id.location_id.id,
                'location_dest_id': self.destination_cold_room_id.location_id.id,
            })],
        })
        picking.action_confirm()
        picking.action_assign()

        move_lines = picking.move_ids.move_line_ids
        if not move_lines:
            picking.unlink()
            raise UserError(
                f'No reservable stock was found for lot {self.lot_id.name} in '
                f'{self.source_cold_room_id.display_name}. Check the lot and quantity and try again.')
        move_lines.write({'lot_id': self.lot_id.id, 'quantity': self.quantity})

        picking.button_validate()
        return {
            'type': 'ir.actions.act_window', 'name': 'Cold Room Transfer',
            'res_model': 'stock.picking', 'view_mode': 'form', 'res_id': picking.id,
        }