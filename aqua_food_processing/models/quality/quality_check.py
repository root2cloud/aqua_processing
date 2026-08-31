import logging

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

_logger = logging.getLogger(__name__)


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
        help='Auto-filled from the Work Order (see _aqua_auto_link_in_process below) for a '
             'Shop Floor In-Process check. Can still be set manually for an In-Process check '
             'that is not raised against a Work Order.')
    aqua_pack_order_id = fields.Many2one(
        'aqua.pack.order', string='Pack Order', check_company=True,
        help='Set this for a Final / Pre-Shipment check that is not raised against a Picking.')

    # The routing operation (Cleaning / Peeling / Deveining / Freezing(IQF) / Grading /
    # Packing -- see AQUA_OPERATION_WORKSHEETS below) this check's Work Order belongs to, if
    # any. Lets the Quality Control dashboard break IPQC results down by station without
    # re-deriving it from workorder_id every time.
    aqua_operation_name = fields.Char(string='Shop Floor Operation', compute='_compute_aqua_operation_name',
        store=True, help='The Work Order operation this In-Process check was raised against.')

    @api.depends('workorder_id.operation_id.name')
    def _compute_aqua_operation_name(self):
        for rec in self:
            rec.aqua_operation_name = rec.workorder_id.operation_id.name or False

    aqua_test_stage = fields.Selection([
        ('raw_material', 'IQC — Incoming (Receiving)'),
        ('in_process', 'IPQC — In-Process (Manufacturing)'),
        ('final', 'Final QC (Pre-Shipment)'),
    ], string='Aqua Stage', tracking=True, default='raw_material',
        help='Which stage of the catch-to-customer lifecycle this check belongs to. Drives '
             'which of the Aqua QC Details fields below apply. Defaults to Raw Material '
             '(IQC) because that is what a Control Point on a Picking auto-generates; '
             '_aqua_auto_link_in_process() below switches it to In-Process (IPQC) for a '
             'Shop Floor check raised against a Work Order instead.')

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

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._aqua_auto_link_in_process()
        return records

    def _aqua_auto_link_in_process(self):
        """Shop Floor worksheet checks (Cleaning / Peeling / Deveining / Freezing(IQF) /
        Grading / Packing -- see AQUA_OPERATION_WORKSHEETS below) are raised against a Work
        Order, not a Picking, so aqua_catch_receipt_id (derived from picking_id) is never set
        on them. Without this, they fall outside AQUA_QC_DOMAIN entirely and the actual
        In-Process (IPQC) inspections happening on the plant floor never show up anywhere on
        the Quality Control dashboard -- silently, since nothing errors.

        Only fills in what's still blank (aqua_processing_order_id) or still at its default
        (aqua_test_stage), so a manually-entered value is never overwritten.
        """
        for rec in self:
            production = rec.production_id or rec.workorder_id.production_id
            if not production:
                continue
            if not rec.aqua_processing_order_id:
                rec.aqua_processing_order_id = production.id
            if rec.aqua_test_stage == 'raw_material' and not rec.picking_id:
                rec.aqua_test_stage = 'in_process'

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


# ---------------------------------------------------------------------------
# Shop Floor Quality Worksheets, one checklist per Work Order operation.
#
# Problem this solves: the Grading Station had a Control Point ("Grading
# Quality", QCP00012) whose Test Type was Pass - Fail with an empty `note`
# field, so the Shop Floor popup showed nothing but the Fail / Pass / Next
# buttons. Odoo's native way to show a real, structured checklist
# (checkboxes, numeric readings, a grade, remarks) on that popup is the
# "Worksheet" Test Type: it opens a small form (backed by its own
# auto-generated model, x_quality_check_worksheet_template_<id>) before the
# operator validates.
#
# _aqua_setup_operation_worksheets() below wires that up for all six Work
# Order operations already present in the routing: Cleaning, Peeling,
# Deveining, Freezing(IQF), Grading, Packing. It is idempotent - safe to run
# again on every `-u aqua_food_processing` - it will not duplicate
# templates, fields or Control Points that already exist. It is triggered
# by the <function> call at the bottom of
# views/quality/quality_check_views.xml, which (unlike post_init_hook) runs
# on both a brand new install AND every subsequent module upgrade, which is
# what we need since aqua_food_processing is already installed.
# ---------------------------------------------------------------------------

# ttype follows ir.model.fields conventions: boolean, float, char, text,
# selection, integer. 4th tuple item is a selection string, or None.
AQUA_OPERATION_WORKSHEETS = [
    {
        "workcenter_name": "Cleaning & Washing Station",
        "operation_name": "Cleaning",
        "point_title": "Washing & Hygiene Check",
        "fields": [
            ("x_dirt_removed", "boolean", "Dirt / Mud / Slime Fully Removed", None),
            ("x_chlorine_ppm", "float", "Wash Water Chlorine (ppm)", None),
            ("x_water_temp_c", "float", "Wash Water Temp (\u00b0C)", None),
            ("x_shell_color_normal", "boolean", "Shell Colour Normal", None),
            ("x_melanosis_observed", "boolean", "Melanosis / Black Spot Observed", None),
            ("x_core_temp_c", "float", "Product Core Temp (\u00b0C)", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
    {
        "workcenter_name": "Peeling Station",
        "operation_name": "Peeling",
        "point_title": "Peeling Quality Check",
        "fields": [
            ("x_peel_type", "selection", "Peel Type Achieved",
             "[('hlso','HLSO - Headless Shell-On'),('pud','PUD - Peeled Undeveined'),"
             "('pdto','PDTO - Peeled Deveined Tail-On'),('pd','PD - Peeled Deveined')]"),
            ("x_shell_fragments_found", "boolean", "Shell Fragments / Legs Found", None),
            ("x_meat_damage", "boolean", "Torn / Crushed Meat", None),
            ("x_hygiene_ok", "boolean", "Gloves / Masks / Hygiene Followed", None),
            ("x_product_temp_c", "float", "Product Temp (\u00b0C)", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
    {
        "workcenter_name": "Deveining Station",
        "operation_name": "Deveining",
        "point_title": "Deveining Completeness Check",
        "fields": [
            ("x_vein_removed", "boolean", "Intestinal Vein Fully Removed", None),
            ("x_cuts_damage", "boolean", "Cuts / Tears From Deveining Tool", None),
            ("x_rewashed", "boolean", "Re-washed After Deveining (1\u20133 ppm chlorine)", None),
            ("x_sample_qty_checked", "integer", "Sample Qty Checked (pcs)", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
    {
        "workcenter_name": "Freezing Station",
        "operation_name": "Freezing(IQF)",
        "point_title": "Freezing Process Check",
        "fields": [
            ("x_tunnel_temp_c", "float", "IQF Tunnel / Plate Freezer Temp (\u00b0C)", None),
            ("x_freeze_time_min", "float", "Freeze Time (minutes)", None),
            ("x_core_temp_c", "float", "Product Core Temp After Freeze (\u00b0C)", None),
            ("x_stpp_pct", "float", "STPP / Phosphate Dip Concentration (%)", None),
            ("x_glaze_pct", "float", "Glaze % Applied", None),
            ("x_clumping_observed", "boolean", "Clumping / Not Individually Frozen", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
    {
        "workcenter_name": "Grading Station",
        "operation_name": "Grading",
        "point_title": "Grading Quality",
        "fields": [
            ("x_grade_declared", "char", "Declared Grade (count/kg, e.g. 21/25)", None),
            ("x_size_uniform", "boolean", "Size Uniform Within Lot", None),
            ("x_count_verified", "boolean", "Count per kg Verified", None),
            ("x_net_weight_kg", "float", "Net Weight After Dripping (kg)", None),
            ("x_reject_qty_kg", "float", "Rejected / Downgraded Qty (kg)", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
    {
        "workcenter_name": "Packing Station",
        "operation_name": "Packing",
        "point_title": "Metal Detection & Pack Check",
        "fields": [
            ("x_metal_detector_passed", "boolean", "Passed Metal Detector", None),
            ("x_label_correct", "boolean", "Carton Label Correct (name/size/batch/date)", None),
            ("x_seal_intact", "boolean", "Seal Integrity OK", None),
            ("x_pack_temp_c", "float", "Product Temp Before Palletizing (\u00b0C)", None),
            ("x_net_weight_kg", "float", "Pack Net Weight (kg)", None),
            ("x_remarks", "text", "Remarks", None),
        ],
    },
]


def _aqua_build_worksheet_arch(field_specs):
    """Return a form arch (string) listing the checklist fields, then the
    built-in Passed / Comments fields, in the same shape Studio would
    generate for a Worksheet template."""
    field_lines = "".join(
        '                        <field name="%s"%s/>\n' % (
            name,
            ' widget="radio"' if ttype == "selection" else "",
        )
        for name, ttype, _label, _sel in field_specs
    )
    return """<form create="false" js_class="worksheet_validation">
    <sheet>
        <h1 invisible="context.get('studio') or context.get('default_x_quality_check_id')">
            <field name="x_quality_check_id"/>
        </h1>
        <group>
            <group string="Checklist">
%s            </group>
            <group string="Result">
                <field name="x_passed"/>
                <field name="x_comments"/>
            </group>
        </group>
    </sheet>
</form>""" % field_lines


def _aqua_get_or_create_worksheet_template(env, title):
    """One worksheet.template == one dedicated model. Re-used by name so
    this can run more than once without creating duplicate models."""
    Template = env["worksheet.template"].sudo()
    template = Template.search([
        ("name", "=", title), ("res_model", "=", "quality.check"),
    ], limit=1)
    if template:
        return template
    # create() on worksheet.template auto-generates the model, default
    # fields (x_quality_check_id, x_comments, x_passed) and default views.
    return Template.create({"name": title, "res_model": "quality.check"})


def _aqua_add_missing_worksheet_fields(env, model, field_specs):
    Fields = env["ir.model.fields"].sudo()
    existing = set(Fields.search([("model_id", "=", model.id)]).mapped("name"))
    to_create = []
    for name, ttype, label, selection in field_specs:
        if name in existing:
            continue
        vals = {
            "name": name,
            "ttype": ttype,
            "field_description": label,
            "model_id": model.id,
        }
        if selection:
            vals["selection"] = selection
        to_create.append(vals)
    if to_create:
        Fields.create(to_create)


def _aqua_update_worksheet_form_view(env, model, field_specs):
    View = env["ir.ui.view"].sudo()
    form_view = View.search([("model", "=", model.model), ("type", "=", "form")], limit=1)
    arch = _aqua_build_worksheet_arch(field_specs)
    if form_view:
        form_view.write({"arch": arch})
    return form_view


def _aqua_find_operation(env, workcenter_name, operation_name):
    Routing = env["mrp.routing.workcenter"].sudo()
    return Routing.search([
        ("workcenter_id.name", "=", workcenter_name),
        ("name", "=", operation_name),
    ], limit=1)


def _aqua_get_worksheet_test_type(env):
    TestType = env["quality.point.test_type"].sudo()
    test_type = TestType.search([("technical_name", "=", "worksheet")], limit=1)
    if not test_type:
        _logger.warning(
            "aqua_food_processing: 'worksheet' quality.point.test_type not found - "
            "is quality_control_worksheet installed?"
        )
    return test_type


def _aqua_get_company_and_team(env):
    company = env["res.company"].sudo().search([("name", "=", "Aqua Processing")], limit=1)
    company = company or env.company
    team = env["quality.alert.team"].sudo().search([("company_id", "=", company.id)], limit=1)
    team = team or env["quality.alert.team"].sudo().search([], limit=1)
    return company, team


def _aqua_get_manufacturing_picking_type(env, company):
    # quality.point.picking_type_ids is required=True; the Shop Floor
    # operation checks all hang off the plant's Manufacturing operation
    # type (code 'mrp_operation'), same one already used by "Grading
    # Quality" / QCP00012.
    PickingType = env["stock.picking.type"].sudo()
    picking_type = PickingType.search([
        ("code", "=", "mrp_operation"), ("company_id", "=", company.id),
    ], limit=1)
    if not picking_type:
        picking_type = PickingType.search([("code", "=", "mrp_operation")], limit=1)
    return picking_type


def _aqua_setup_operation_worksheets_impl(env):
    test_type = _aqua_get_worksheet_test_type(env)
    if not test_type:
        return
    company, team = _aqua_get_company_and_team(env)
    picking_type = _aqua_get_manufacturing_picking_type(env, company)
    Point = env["quality.point"].sudo()

    for spec in AQUA_OPERATION_WORKSHEETS:
        operation = _aqua_find_operation(env, spec["workcenter_name"], spec["operation_name"])
        if not operation:
            _logger.warning(
                "aqua_food_processing: operation '%s' on work center '%s' not found - skipping.",
                spec["operation_name"], spec["workcenter_name"],
            )
            continue

        # Reuse an existing Control Point on this operation (e.g. the
        # already-present "Grading Quality") instead of creating a duplicate.
        point = Point.search([
            ("operation_id", "=", operation.id),
            ("title", "=", spec["point_title"]),
        ], limit=1)

        template = _aqua_get_or_create_worksheet_template(env, spec["point_title"])
        _aqua_add_missing_worksheet_fields(env, template.model_id, spec["fields"])
        _aqua_update_worksheet_form_view(env, template.model_id, spec["fields"])
        template._generate_qweb_report_template()

        success_domain = "[('x_passed', '=', True)]"

        if point:
            point.write({
                "test_type_id": test_type.id,
                "worksheet_template_id": template.id,
                "worksheet_success_conditions": success_domain,
                "source_document": "operation",
                # A leftover non-empty `note` (even just an empty-looking
                # "<div><br></div>") stops the Shop Floor tablet from
                # jumping straight to the worksheet checklist the way it
                # does for every other operation - it shows an extra
                # confirmation popup with a "Fill in worksheet" button
                # first instead. Clear it so all 6 operations behave the
                # same way.
                "note": False,
            })
            _logger.info("aqua_food_processing: updated existing Control Point '%s'.", point.name)
        else:
            Point.create({
                "title": spec["point_title"],
                "operation_id": operation.id,
                "test_type_id": test_type.id,
                "worksheet_template_id": template.id,
                "worksheet_success_conditions": success_domain,
                "source_document": "operation",
                "company_id": company.id,
                "team_id": team.id if team else False,
                "test_report_type": "pdf",
                "picking_type_ids": [(6, 0, picking_type.ids)] if picking_type else False,
                "note": False,
            })
            _logger.info(
                "aqua_food_processing: created Control Point '%s' on operation '%s'.",
                spec["point_title"], spec["operation_name"],
            )


class QualityPoint(models.Model):
    """Entry point so the Shop Floor worksheet checklists above can be
    (re)built from a <function> call in
    views/quality/quality_check_views.xml on every module install/upgrade.
    Safe to call repeatedly: it only creates what is missing.
    """
    _inherit = 'quality.point'

    @api.model
    def _aqua_setup_operation_worksheets(self):
        _aqua_setup_operation_worksheets_impl(self.env)