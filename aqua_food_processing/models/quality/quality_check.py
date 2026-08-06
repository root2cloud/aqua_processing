from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

HISTAMINE_THRESHOLD_PPM = 200.0  # regulatory ceiling, configurable per company in future
CORE_TEMP_MAX_C = 4.0  # max acceptable core temperature of chilled raw shrimp on arrival
PHOSPHATE_MAX_PCT = 0.5  # legal ceiling for added polyphosphate/STPP, % of net weight

# Fields that carry an actual inspection RESULT (as opposed to routing/reference fields).
# Once a Certificate of Analysis has been issued off a check, none of these may be edited --
# mirrors the old aqua.quality.test.write() guard.
AQUA_RESULT_FIELDS = {
    'aqua_sensory_score', 'aqua_histamine_ppm', 'aqua_ph_value', 'aqua_moisture_percentage',
    'aqua_total_plate_count', 'aqua_e_coli_count', 'aqua_salmonella_detected',
    'aqua_intake_decision', 'aqua_antibiotic_result', 'aqua_sulphite_result',
    'aqua_core_temp_c', 'quality_state',
}


class QualityCheck(models.Model):
    """Extends Odoo's native Quality Check (the record behind the "Quality Checks" smart
    button / pop-up wizard on a Picking) with the full Aqua Processing inspection checklist
    that used to live on the separate, disconnected aqua.quality.test model.

    Rationale: the plant floor was already doing the real Pass/Fail workflow here (Control
    Point QCP00011 "Raw Shrimp" -> auto-created quality.check on the QC internal transfer,
    Pass/Fail via the pop-up wizard). aqua.quality.test was a second, parallel record the
    inspector had to fill in separately, with no link enforced between the two other than a
    manually-clicked button that isn't even wired into any view. Putting the aqua fields
    directly on quality.check makes the native flow the single source of truth: one record,
    one Pass/Fail state, one place to look.
    """
    _inherit = 'quality.check'

    # ------------------------------------------------------------------
    # Lifecycle linkage. picking_id already exists natively -- for a Raw
    # Material check that picking is normally the "Aqua Processing:
    # Quality Control" internal transfer, and aqua_catch_receipt_id is
    # derived straight from it (mirrors stock.picking.aqua_catch_receipt_id).
    # For In-Process / Final checks that aren't raised against a picking,
    # link the Processing Order / Pack Order directly instead.
    # ------------------------------------------------------------------
    aqua_catch_receipt_id = fields.Many2one(
        'aqua.catch.receipt', string='Catch Receipt',
        related='picking_id.aqua_catch_receipt_id', store=True, readonly=True,
        help='Automatically derived from the Picking this check belongs to.')
    aqua_processing_order_id = fields.Many2one(
        'mrp.production', string='Processing Order', check_company=True,
        help='Set this for an In-Process check that is not raised against a Picking.')
    aqua_pack_order_id = fields.Many2one(
        'aqua.pack.order', string='Pack Order', check_company=True,
        help='Set this for a Final / Pre-Shipment check that is not raised against a Picking.')

    aqua_test_stage = fields.Selection([
        ('raw_material', 'Raw Material (Receiving)'),
        ('in_process', 'In-Process'),
        ('final', 'Final / Pre-Shipment'),
    ], string='Aqua Stage', tracking=True, default='raw_material',
        help='Which stage of the catch-to-customer lifecycle this check belongs to. Drives '
             'which of the Aqua QC Details fields below apply. Defaults to Raw Material '
             'because that is the only stage currently auto-generated from a Control Point '
             '(picking_id set); set it manually for In-Process / Final checks.')

    certificate_id = fields.Many2one('aqua.certificate.of.analysis', string='Certificate of Analysis', copy=False)

    # ------------------------------------------------------------------
    # 1. Vehicle & transport check -- done before unloading.
    # ------------------------------------------------------------------
    aqua_vehicle_cold_chain_maintained = fields.Boolean(string='Cold Chain Maintained in Transit')
    aqua_transit_temp_c = fields.Float(string='Transit Temp (°C)',
        help='Reefer/ice-box temperature during transport, as read on arrival.')
    aqua_vehicle_hygiene_ok = fields.Boolean(string='Vehicle Clean / No Contamination Risk')

    # ------------------------------------------------------------------
    # 2. Documentation check.
    # ------------------------------------------------------------------
    aqua_catch_certificate_verified = fields.Boolean(string='Catch Certificate / Harvest Declaration Verified',
        help='Species, farm/harvest area and harvest date declared and checked -- required for '
             'traceability and export compliance (e.g. EU IUU, US FDA).')
    aqua_vendor_count_declaration_verified = fields.Boolean(string='Vendor Count/Grade Declaration Verified')
    aqua_farm_certification_verified = fields.Boolean(string='Antibiotic-Free / Farm Certification Verified')

    # ------------------------------------------------------------------
    # 3. Temperature check on arrival -- core temperature of the shrimp
    # itself (probe thermometer), not the truck's ambient reading.
    # ------------------------------------------------------------------
    aqua_core_temp_c = fields.Float(string='Core Temperature (°C)',
        help='Probe temperature taken directly on the shrimp, not the ambient/reefer reading. '
             'Reject or downgrade above %.0f°C.' % CORE_TEMP_MAX_C)

    # ------------------------------------------------------------------
    # 4. Sensory / organoleptic evaluation.
    # ------------------------------------------------------------------
    aqua_shell_color_normal = fields.Boolean(string='Shell Color/Translucency Normal')
    aqua_melanosis_observed = fields.Boolean(string='Melanosis (Black Spot) Beyond Threshold')
    aqua_odor_normal = fields.Boolean(string='Fresh Sea Odor (No Ammonia/Sour Smell)')
    aqua_texture_firm = fields.Boolean(string='Flesh Firm')
    aqua_shell_adherence_tight = fields.Boolean(string='Shell Tightly Attached to Body')
    aqua_eyes_intact = fields.Boolean(string='Eyes Black & Firm')
    aqua_sensory_score = fields.Float(string='Sensory Score (0-10)')
    aqua_sensory_notes = fields.Text(string='Sensory Notes')

    # ------------------------------------------------------------------
    # 5. Physical / foreign matter check.
    # ------------------------------------------------------------------
    aqua_foreign_matter_found = fields.Boolean(string='Foreign Matter Found',
        help='Sand, shell fragments, other species, plastic/debris found in the sample.')
    aqua_foreign_matter_notes = fields.Char(string='Foreign Matter Details')

    # ------------------------------------------------------------------
    # 6. Count & size verification -- the actual sample count/avg body
    # weight is taken once, at the gate, on the Catch Receipt/Delivery
    # (aqua.catch.receipt / stock.picking aqua_sample_* fields). These are
    # related read-only mirrors so the inspector sees vendor-claimed vs.
    # actual count right here on the check, without leaving this form.
    # ------------------------------------------------------------------
    aqua_vendor_shrimp_count = fields.Integer(string='Vendor Reported Count (per kg)',
        related='aqua_catch_receipt_id.vendor_shrimp_count', readonly=True)
    aqua_actual_shrimp_count = fields.Float(string='Actual Count (per kg)',
        related='picking_id.aqua_shrimp_count', readonly=True)
    aqua_count_variance_pct = fields.Float(string='Count Variance %', compute='_compute_aqua_count_variance')

    @api.depends('aqua_vendor_shrimp_count', 'aqua_actual_shrimp_count')
    def _compute_aqua_count_variance(self):
        for rec in self:
            rec.aqua_count_variance_pct = (
                (rec.aqua_actual_shrimp_count - rec.aqua_vendor_shrimp_count) / rec.aqua_vendor_shrimp_count * 100.0
            ) if rec.aqua_vendor_shrimp_count else 0.0

    # ------------------------------------------------------------------
    # 7. Chemical / residue screening.
    # ------------------------------------------------------------------
    aqua_antibiotic_result = fields.Selection([
        ('not_tested', 'Not Tested'),
        ('not_detected', 'Not Detected'),
        ('detected', 'Detected'),
    ], string='Antibiotic Residue (Chloramphenicol/Nitrofurans)', default='not_tested')
    aqua_sulphite_result = fields.Selection([
        ('not_tested', 'Not Tested'),
        ('not_detected', 'Not Detected'),
        ('detected', 'Detected'),
    ], string='Sulphite/Preservative (Undeclared Metabisulphite)', default='not_tested')
    aqua_phosphate_stpp_pct = fields.Float(string='Phosphate/STPP %',
        help='Polyphosphate treatment level, if any, as %% of net weight. Legal ceiling %.1f%%.'
             % PHOSPHATE_MAX_PCT)
    aqua_ph_value = fields.Float(string='pH (Freshness Proxy)')
    aqua_histamine_ppm = fields.Float(string='Histamine (ppm)')
    aqua_moisture_percentage = fields.Float(string='Moisture %')

    # ------------------------------------------------------------------
    # 8. Microbiological sampling -- usually a rotating/periodic lab
    # sample rather than every load, so it can carry its own hold flag
    # (aqua_on_hold) without blocking the gate decision below.
    # ------------------------------------------------------------------
    aqua_microbiology_sampled = fields.Boolean(string='Sample Sent to Lab')
    aqua_total_plate_count = fields.Float(string='Total Plate Count (cfu/g)')
    aqua_e_coli_count = fields.Float(string='E. coli (cfu/g)')
    aqua_salmonella_detected = fields.Boolean(string='Salmonella Detected')

    # ------------------------------------------------------------------
    # 9. Decision point -- the outcome of the gate inspection for the
    # LOAD, kept separate from quality_state (which is this record's own
    # Pass/Fail/To-do status). A check can Pass yet still have the load
    # Downgraded (price renegotiated), for example.
    # ------------------------------------------------------------------
    aqua_intake_decision = fields.Selection([
        ('accept', 'Accept'),
        ('reject', 'Reject'),
        ('downgrade', 'Downgrade / Conditional Accept'),
    ], string='Intake Decision', tracking=True)
    aqua_decision_notes = fields.Text(string='Decision Notes',
        help='Reason for rejection, or terms of a downgrade/conditional accept '
             '(e.g. price renegotiated for count/freshness mismatch).')
    aqua_rejected_quantity = fields.Float(string='Rejected Quantity (kg)')

    # quality_state on native quality.check only supports none/pass/fail -- there is no
    # built-in "Hold". This flag lets an inspector park a check (e.g. pending a lab result)
    # without forcing a premature Pass or Fail.
    aqua_on_hold = fields.Boolean(string='On Hold', tracking=True, copy=False,
        help='Use this to park an inspection (e.g. awaiting a lab result) without recording '
             'a Pass or Fail yet. Does not change the Status (To Do/Passed/Failed) itself.')

    @api.constrains('aqua_histamine_ppm')
    def _check_aqua_histamine(self):
        for rec in self:
            if rec.aqua_histamine_ppm < 0:
                raise ValidationError(_('Histamine ppm cannot be negative.'))
            if rec.aqua_histamine_ppm > HISTAMINE_THRESHOLD_PPM:
                raise ValidationError(_(
                    'Histamine level %(value)s ppm exceeds the regulatory threshold of '
                    '%(limit)s ppm. This must be recorded as a Failed check, not overridden.',
                    value=rec.aqua_histamine_ppm, limit=HISTAMINE_THRESHOLD_PPM,
                ))

    @api.onchange('aqua_core_temp_c', 'aqua_antibiotic_result', 'aqua_sulphite_result',
                   'aqua_melanosis_observed', 'aqua_odor_normal', 'aqua_texture_firm',
                   'aqua_foreign_matter_found', 'aqua_phosphate_stpp_pct', 'aqua_salmonella_detected')
    def _onchange_aqua_suggest_decision(self):
        """Not a hard rule -- just nudges the inspector's Intake Decision so an obvious reject
        (over-temperature, antibiotic/sulphite detected, off-odor, mushy texture, foreign
        matter, over-limit phosphate, salmonella) isn't accidentally left as Accept. The
        inspector can always override; nothing here blocks the form."""
        for rec in self:
            if rec.aqua_test_stage != 'raw_material' or rec.aqua_intake_decision:
                continue
            hard_fail = (
                (rec.aqua_core_temp_c and rec.aqua_core_temp_c > CORE_TEMP_MAX_C)
                or rec.aqua_antibiotic_result == 'detected'
                or rec.aqua_sulphite_result == 'detected'
                or rec.aqua_melanosis_observed
                or rec.aqua_foreign_matter_found
                or (rec.aqua_phosphate_stpp_pct and rec.aqua_phosphate_stpp_pct > PHOSPHATE_MAX_PCT)
                or rec.aqua_salmonella_detected
            )
            if hard_fail:
                rec.aqua_intake_decision = 'reject'

    def write(self, vals):
        for rec in self:
            if rec.certificate_id and AQUA_RESULT_FIELDS.intersection(vals.keys()):
                raise UserError(_('Result fields cannot be edited once a Certificate of '
                                   'Analysis has been issued for this check.'))
        return super().write(vals)

    def do_pass(self):
        res = super().do_pass()
        for rec in self:
            vals = {'aqua_on_hold': False}
            if rec.aqua_test_stage == 'raw_material' and not rec.aqua_intake_decision:
                vals['aqua_intake_decision'] = 'accept'
            rec.write(vals)
        return res

    def do_fail(self):
        res = super().do_fail()
        for rec in self:
            if rec.aqua_test_stage == 'raw_material' and not rec.aqua_intake_decision:
                rec.write({'aqua_intake_decision': 'reject'})
        return res

    def action_aqua_hold(self):
        self.write({'aqua_on_hold': True})

    def action_aqua_reset_hold(self):
        self.write({'aqua_on_hold': False})

    def action_view_certificate(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': _('Certificate of Analysis'),
            'res_model': 'aqua.certificate.of.analysis', 'view_mode': 'form',
            'res_id': self.certificate_id.id,
        }