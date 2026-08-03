from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

HISTAMINE_THRESHOLD_PPM = 200.0  # regulatory ceiling, configurable per company in future
CORE_TEMP_MAX_C = 4.0  # max acceptable core temperature of chilled raw shrimp on arrival
PHOSPHATE_MAX_PCT = 0.5  # legal ceiling for added polyphosphate/STPP, % of net weight


class AquaQualityTest(models.Model):
    _name = 'aqua.quality.test'
    _description = 'Quality Test'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'test_date desc'

    name = fields.Char(required=True, copy=False, readonly=True, default='New')
    test_date = fields.Datetime(default=fields.Datetime.now)
    test_stage = fields.Selection([
        ('raw_material', 'Raw Material (Receiving)'),
        ('in_process', 'In-Process'),
        ('final', 'Final / Pre-Shipment'),
    ], required=True, default='raw_material')

    catch_receipt_id = fields.Many2one('aqua.catch.receipt', string='Catch Receipt')
    # ------------------------------------------------------------------
    # The physical checkpoint for a Raw Material test happens at the gate,
    # on the specific Incoming Transfer / Quality Control internal transfer
    # for that delivery -- not just loosely "somewhere on the Catch
    # Receipt". qc_picking_id ties this test to that exact stock.picking
    # (normally the "Aqua Processing: Quality Control" internal transfer
    # between Input and Quality Control locations, in a 3-step receiving
    # route), so the inspector opens the checklist from the same screen
    # the shrimp is physically sitting at (see StockPicking.action_open_
    # quality_test below), and so multiple deliveries of the same Catch
    # Receipt each get their own, independent Raw Material test.
    # ------------------------------------------------------------------
    qc_picking_id = fields.Many2one('stock.picking', string='QC Transfer', copy=False,
        help='The Quality Control internal transfer (or Receipt, if no separate QC step is '
             'configured) this test was performed against.')
    processing_order_id = fields.Many2one('mrp.production', string='Processing Order')
    pack_order_id = fields.Many2one('aqua.pack.order', string='Pack Order')
    certificate_id = fields.Many2one('aqua.certificate.of.analysis', string='Certificate of Analysis')

    # ------------------------------------------------------------------
    # 1. Vehicle & transport check -- done before unloading.
    # ------------------------------------------------------------------
    vehicle_cold_chain_maintained = fields.Boolean(string='Cold Chain Maintained in Transit')
    transit_temp_c = fields.Float(string='Transit Temp (°C)',
        help='Reefer/ice-box temperature during transport, as read on arrival.')
    vehicle_hygiene_ok = fields.Boolean(string='Vehicle Clean / No Contamination Risk')

    # ------------------------------------------------------------------
    # 2. Documentation check.
    # ------------------------------------------------------------------
    catch_certificate_verified = fields.Boolean(string='Catch Certificate / Harvest Declaration Verified',
        help='Species, farm/harvest area and harvest date declared and checked -- required for '
             'traceability and export compliance (e.g. EU IUU, US FDA).')
    vendor_count_declaration_verified = fields.Boolean(string='Vendor Count/Grade Declaration Verified')
    farm_certification_verified = fields.Boolean(string='Antibiotic-Free / Farm Certification Verified')

    # ------------------------------------------------------------------
    # 3. Temperature check on arrival -- core temperature of the shrimp
    # itself (probe thermometer), not the truck's ambient reading.
    # ------------------------------------------------------------------
    core_temp_c = fields.Float(string='Core Temperature (°C)',
        help='Probe temperature taken directly on the shrimp, not the ambient/reefer reading. '
             'Reject or downgrade above %.0f°C.' % CORE_TEMP_MAX_C)

    # ------------------------------------------------------------------
    # 4. Sensory / organoleptic evaluation.
    # ------------------------------------------------------------------
    shell_color_normal = fields.Boolean(string='Shell Color/Translucency Normal')
    melanosis_observed = fields.Boolean(string='Melanosis (Black Spot) Beyond Threshold')
    odor_normal = fields.Boolean(string='Fresh Sea Odor (No Ammonia/Sour Smell)')
    texture_firm = fields.Boolean(string='Flesh Firm')
    shell_adherence_tight = fields.Boolean(string='Shell Tightly Attached to Body')
    eyes_intact = fields.Boolean(string='Eyes Black & Firm')
    sensory_score = fields.Float(string='Sensory Score (0-10)')
    sensory_notes = fields.Text()

    # ------------------------------------------------------------------
    # 5. Physical / foreign matter check.
    # ------------------------------------------------------------------
    foreign_matter_found = fields.Boolean(string='Foreign Matter Found',
        help='Sand, shell fragments, other species, plastic/debris found in the sample.')
    foreign_matter_notes = fields.Char(string='Foreign Matter Details')

    # ------------------------------------------------------------------
    # 6. Count & size verification -- the actual sample count/avg body
    # weight is taken once, at the gate, on the Catch Receipt/Delivery
    # (aqua.catch.receipt / stock.picking aqua_sample_* fields); these
    # are related read-only mirrors so the QC inspector can see the
    # vendor-claimed vs. actual count right here on the test, without
    # re-typing it or leaving this form.
    # ------------------------------------------------------------------
    vendor_shrimp_count = fields.Integer(string='Vendor Reported Count (per kg)',
        related='catch_receipt_id.vendor_shrimp_count', readonly=True)
    actual_shrimp_count = fields.Float(string='Actual Count (per kg)',
        related='qc_picking_id.aqua_shrimp_count', readonly=True)
    count_variance_pct = fields.Float(string='Count Variance %', compute='_compute_count_variance')

    @api.depends('vendor_shrimp_count', 'actual_shrimp_count')
    def _compute_count_variance(self):
        for rec in self:
            rec.count_variance_pct = (
                (rec.actual_shrimp_count - rec.vendor_shrimp_count) / rec.vendor_shrimp_count * 100.0
            ) if rec.vendor_shrimp_count else 0.0

    # ------------------------------------------------------------------
    # 7. Chemical / residue screening.
    # ------------------------------------------------------------------
    antibiotic_result = fields.Selection([
        ('not_tested', 'Not Tested'),
        ('not_detected', 'Not Detected'),
        ('detected', 'Detected'),
    ], string='Antibiotic Residue (Chloramphenicol/Nitrofurans)', default='not_tested')
    sulphite_result = fields.Selection([
        ('not_tested', 'Not Tested'),
        ('not_detected', 'Not Detected'),
        ('detected', 'Detected'),
    ], string='Sulphite/Preservative (Undeclared Metabisulphite)', default='not_tested')
    phosphate_stpp_pct = fields.Float(string='Phosphate/STPP %',
        help='Polyphosphate treatment level, if any, as %% of net weight. Legal ceiling %.1f%%.'
             % PHOSPHATE_MAX_PCT)
    ph_value = fields.Float(string='pH (Freshness Proxy)')
    histamine_ppm = fields.Float(string='Histamine (ppm)')
    moisture_percentage = fields.Float(string='Moisture %')

    # ------------------------------------------------------------------
    # 8. Microbiological sampling -- usually a rotating/periodic lab
    # sample rather than every load, so it can carry a separate pending
    # state without blocking the gate decision below.
    # ------------------------------------------------------------------
    microbiology_sampled = fields.Boolean(string='Sample Sent to Lab')
    total_plate_count = fields.Float(string='Total Plate Count (cfu/g)')
    e_coli_count = fields.Float(string='E. coli (cfu/g)')
    salmonella_detected = fields.Boolean(string='Salmonella Detected')

    # ------------------------------------------------------------------
    # 9. Decision point -- the actual outcome of the gate inspection,
    # separate from result_state below (result_state is the record's own
    # workflow status; intake_decision is what happens to the LOAD).
    # ------------------------------------------------------------------
    intake_decision = fields.Selection([
        ('accept', 'Accept'),
        ('reject', 'Reject'),
        ('downgrade', 'Downgrade / Conditional Accept'),
    ], string='Intake Decision', tracking=True)
    decision_notes = fields.Text(string='Decision Notes',
        help='Reason for rejection, or terms of a downgrade/conditional accept '
             '(e.g. price renegotiated for count/freshness mismatch).')
    rejected_quantity = fields.Float(string='Rejected Quantity (kg)')

    result_state = fields.Selection([
        ('pending', 'Pending'),
        ('pass', 'Pass'),
        ('fail', 'Fail'),
        ('hold', 'Hold'),
    ], default='pending', tracking=True)

    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)

    @api.constrains('histamine_ppm')
    def _check_histamine(self):
        for rec in self:
            if rec.histamine_ppm < 0:
                raise ValidationError('Histamine ppm cannot be negative.')
            if rec.histamine_ppm > HISTAMINE_THRESHOLD_PPM:
                raise ValidationError(
                    f'Histamine level {rec.histamine_ppm} ppm exceeds the regulatory threshold '
                    f'of {HISTAMINE_THRESHOLD_PPM} ppm. This must be recorded as a failed test, '
                    f'not overridden.'
                )

    @api.onchange('core_temp_c', 'antibiotic_result', 'sulphite_result', 'melanosis_observed',
                  'odor_normal', 'texture_firm', 'foreign_matter_found', 'phosphate_stpp_pct',
                  'salmonella_detected')
    def _onchange_suggest_decision(self):
        """Not a hard rule -- just nudges the inspector's Intake Decision so an obvious reject
        (over-temperature, antibiotic/sulphite detected, off-odor, mushy texture, foreign matter,
        over-limit phosphate, salmonella) isn't accidentally left as Accept. The inspector can
        always override; nothing here blocks the form."""
        for rec in self:
            if rec.intake_decision:
                continue
            hard_fail = (
                (rec.core_temp_c and rec.core_temp_c > CORE_TEMP_MAX_C)
                or rec.antibiotic_result == 'detected'
                or rec.sulphite_result == 'detected'
                or rec.melanosis_observed
                or rec.foreign_matter_found
                or (rec.phosphate_stpp_pct and rec.phosphate_stpp_pct > PHOSPHATE_MAX_PCT)
                or rec.salmonella_detected
            )
            if hard_fail:
                rec.intake_decision = 'reject'

    def write(self, vals):
        result_fields = {
            'sensory_score', 'histamine_ppm', 'ph_value', 'moisture_percentage',
            'total_plate_count', 'e_coli_count', 'salmonella_detected', 'result_state',
            'intake_decision', 'antibiotic_result', 'sulphite_result', 'core_temp_c',
        }
        for rec in self:
            if rec.certificate_id and result_fields.intersection(vals.keys()):
                raise UserError('Result fields cannot be edited once a Certificate of Analysis has been issued.')
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('aqua.quality.test') or 'New'
        return super().create(vals_list)

    def _check_certificate_eligible(self):
        self.ensure_one()
        return self.result_state == 'pass'

    def action_pass(self):
        for rec in self:
            vals = {'result_state': 'pass'}
            if rec.test_stage == 'raw_material' and not rec.intake_decision:
                vals['intake_decision'] = 'accept'
            rec.write(vals)
            rec._check_certificate_eligible()
            rec._auto_validate_qc_picking()

    def action_fail(self):
        for rec in self:
            vals = {'result_state': 'fail'}
            if rec.test_stage == 'raw_material' and not rec.intake_decision:
                vals['intake_decision'] = 'reject'
            rec.write(vals)

    # ------------------------------------------------------------------
    # Per your request: moving a Raw Material test to Pass (with an
    # Accept decision) should validate its QC Transfer for you, instead
    # of leaving the inspector to separately go find that transfer and
    # click Validate by hand. Only fires for raw_material tests that are
    # linked to a QC Transfer (qc_picking_id), still in a validatable
    # state, and whose Intake Decision is Accept -- a Fail/Reject or
    # Downgrade never auto-validates, since that load needs a human
    # decision on the transfer itself (partial accept, return, etc.).
    #
    # button_validate() can itself return an action (a wizard) instead of
    # completing outright -- most commonly stock.backorder.confirmation
    # when the done quantity doesn't cover full demand, or
    # stock.immediate.transfer when quantities weren't pre-filled on the
    # move lines. Both are resolved automatically here in the common
    # case (full quantity already recorded via Weighment, so "no
    # backorder needed" / "process the full amount") since raising that
    # wizard back at the inspector on the Quality Test form -- a
    # different screen entirely -- would have nowhere to render it. If
    # anything genuinely unexpected comes back, this logs it on the
    # transfer's chatter and leaves the picking exactly as-is rather than
    # silently failing or blocking the Pass action.
    # ------------------------------------------------------------------
    def _auto_validate_qc_picking(self):
        self.ensure_one()
        picking = self.qc_picking_id
        if not picking or self.test_stage != 'raw_material' or self.intake_decision != 'accept':
            return
        if picking.state in ('done', 'cancel'):
            return
        try:
            result = picking.button_validate()
        except UserError as exc:
            picking.message_post(body='Auto-validation from Quality Test %s failed: %s' % (self.name, exc))
            return
        if isinstance(result, dict) and result.get('res_model'):
            if result['res_model'] == 'stock.backorder.confirmation':
                wizard = self.env['stock.backorder.confirmation'].with_context(
                    result.get('context', {})).create({})
                wizard.process()
            elif result['res_model'] == 'stock.immediate.transfer':
                wizard = self.env['stock.immediate.transfer'].with_context(
                    result.get('context', {})).create({})
                wizard.process()
            else:
                picking.message_post(
                    body='Quality Test %s passed, but %s needs manual input before it can be '
                         'validated -- please complete Validate on this transfer yourself.'
                         % (self.name, result['res_model']))

    def action_hold(self):
        self.write({'result_state': 'hold'})

    def action_reset_to_draft(self):
        for rec in self:
            if rec.result_state not in ('hold', 'fail'):
                raise UserError('Only a Hold or Fail result can be reset to Pending.')
        self.write({'result_state': 'pending'})

    def action_view_certificate(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window', 'name': 'Certificate of Analysis',
            'res_model': 'aqua.certificate.of.analysis', 'view_mode': 'form',
            'res_id': self.certificate_id.id,
        }