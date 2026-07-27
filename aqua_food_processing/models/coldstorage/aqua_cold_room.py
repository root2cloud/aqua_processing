from odoo import api, fields, models
from odoo.exceptions import UserError


class AquaColdRoom(models.Model):
    _name = 'aqua.cold.room'
    _description = 'Cold Room / Storage Zone'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'name'

    name = fields.Char(required=True)
    code = fields.Char()
    location_id = fields.Many2one('stock.location', string='Stock Location')

    # ------------------------------------------------------------------
    # capacity_kg used to be a bare Float
    # with no connection to Odoo's own capacity engine, so native putaway
    # over-capacity warnings never fired for this location and the number
    # could silently drift from reality. It is now backed by a real
    # stock.storage.category record kept in sync automatically in
    # _sync_storage_category() below, so the Aqua user still only ever
    # edits capacity_kg on this form -- the underlying Inventory config
    # object is created/maintained for them, never touched by hand.
    # ------------------------------------------------------------------
    capacity_kg = fields.Float(
        string='Capacity (kg)',
        help='Maximum stock weight allowed in this cold room. Automatically pushed onto the '
             "linked Storage Category's Max Weight so Odoo's own putaway capacity checks apply.")
    storage_category_id = fields.Many2one(
        'stock.storage.category', string='Storage Category', copy=False, readonly=True,
        help='Auto-created and kept in sync with this Cold Room; not meant to be edited directly.')

    min_temperature = fields.Float(string='Min Temp (°C)', default=-25.0)
    max_temperature = fields.Float(string='Max Temp (°C)', default=-18.0)
    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)
    active = fields.Boolean(default=True)

    temperature_log_ids = fields.One2many('aqua.temperature.log', 'cold_room_id', string='Temperature Logs')
    blast_freeze_cycle_ids = fields.One2many('aqua.blast.freeze.cycle', 'cold_room_id', string='Blast Freeze Cycles')

    temperature_log_count = fields.Integer(compute='_compute_counts')
    blast_freeze_cycle_count = fields.Integer(compute='_compute_counts')
    current_lot_count = fields.Integer(compute='_compute_counts', string='Active Lots in Storage')
    current_weight_kg = fields.Float(compute='_compute_counts', string='Current Weight in Storage (kg)',
                                      help='Live sum of stock.quant quantity at this location, for comparison '
                                           'against Capacity (kg) without leaving this form.')

    def _compute_counts(self):
        for rec in self:
            rec.temperature_log_count = len(rec.temperature_log_ids)
            rec.blast_freeze_cycle_count = len(rec.blast_freeze_cycle_ids)
            quants = self.env['stock.quant'].search(
                [('location_id', '=', rec.location_id.id), ('quantity', '>', 0)]
            ) if rec.location_id else self.env['stock.quant']
            rec.current_lot_count = len(quants)
            rec.current_weight_kg = sum(quants.mapped('quantity'))

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._sync_storage_category()
        return records

    def write(self, vals):
        res = super().write(vals)
        if {'capacity_kg', 'location_id', 'name'} & set(vals.keys()):
            self._sync_storage_category()
        return res

    def _sync_storage_category(self):
        """Create/update a real stock.storage.category for this cold room and attach it
        to location_id, so Odoo's native max-weight putaway enforcement is actually live --
        instead of capacity_kg being a number that only this form knows about."""
        StorageCategory = self.env['stock.storage.category']
        for rec in self:
            if not rec.location_id:
                continue
            category = rec.storage_category_id
            category_vals = {
                'name': f'Cold Room: {rec.name}',
                'max_weight': rec.capacity_kg,
                'allow_new_product': 'mixed',
            }
            if category:
                category.write(category_vals)
            else:
                category = StorageCategory.create(category_vals)
                rec.storage_category_id = category.id
            if rec.location_id.storage_category_id != category:
                rec.location_id.storage_category_id = category.id

    def action_view_temperature_logs(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Temperature Logs (30-day)',
            'res_model': 'aqua.temperature.log', 'view_mode': 'list,form',
            'domain': [('cold_room_id', '=', self.id)],
        }

    def action_view_blast_freeze_cycles(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Blast Freeze Cycles',
            'res_model': 'aqua.blast.freeze.cycle', 'view_mode': 'list,form',
            'domain': [('cold_room_id', '=', self.id)],
        }


class AquaTemperatureLog(models.Model):
    _name = 'aqua.temperature.log'
    _description = 'Cold Room Temperature Log'
    _order = 'log_datetime desc'

    cold_room_id = fields.Many2one('aqua.cold.room', required=True, ondelete='cascade')
    log_datetime = fields.Datetime(default=fields.Datetime.now, required=True)
    temperature = fields.Float(string='Temperature (°C)', required=True)
    is_excursion = fields.Boolean(string='Out of Range', default=False, readonly=True)
    source = fields.Selection([('manual', 'Manual'), ('sensor', 'IoT Sensor')], default='manual')

    @api.constrains('temperature')
    def _check_temperature(self):
        # Out-of-range values do not hard-block entry, they auto-flag.
        for rec in self:
            room = rec.cold_room_id
            if room and (rec.temperature < room.min_temperature or rec.temperature > room.max_temperature):
                rec.is_excursion = True
                room.message_post(
                    body=f'Temperature excursion recorded: {rec.temperature}°C '
                         f'(expected {room.min_temperature}°C to {room.max_temperature}°C)'
                )

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for rec in records:
            rec._check_temperature()
        return records


class AquaBlastFreezeCycle(models.Model):
    _name = 'aqua.blast.freeze.cycle'
    _description = 'Blast Freeze Cycle'
    _order = 'start_datetime desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    cold_room_id = fields.Many2one('aqua.cold.room', required=True)
    processing_order_id = fields.Many2one('mrp.production', string='Processing Order')
    start_datetime = fields.Datetime()
    end_datetime = fields.Datetime()
    duration_hours = fields.Float(compute='_compute_duration', store=True)
    state = fields.Selection([
        ('scheduled', 'Scheduled'), ('running', 'Running'), ('completed', 'Completed'),
    ], default='scheduled')

    @api.depends('start_datetime', 'end_datetime')
    def _compute_duration(self):
        for rec in self:
            if rec.start_datetime and rec.end_datetime:
                rec.duration_hours = (rec.end_datetime - rec.start_datetime).total_seconds() / 3600.0
            else:
                rec.duration_hours = 0.0

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.blast.freeze.cycle') or 'New'
        return super().create(vals_list)

    def action_start(self):
        self.write({'state': 'running', 'start_datetime': fields.Datetime.now()})

    def action_stop(self):
        self.write({'state': 'completed', 'end_datetime': fields.Datetime.now()})

    def action_reset_to_draft(self):
        for rec in self:
            if rec.state not in ('running', 'completed'):
                raise UserError('Only a Running or Completed cycle can be reset to Scheduled.')
        self.write({'state': 'scheduled'})