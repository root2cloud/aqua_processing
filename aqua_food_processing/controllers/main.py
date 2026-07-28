import json

from odoo import http
from odoo.http import request
from odoo.exceptions import AccessError, MissingError


class AquaProcurementController(http.Controller):

    @http.route('/aqua/procurement/weighbridge', type='json', auth='public', methods=['POST'], csrf=False)
    def weighbridge_webhook(self, **kwargs):
        """Receives weighbridge scale readings for a catch receipt (Community-safe: no IoT Box app)."""
        data = request.get_json_data() if hasattr(request, 'get_json_data') else kwargs
        receipt_id = data.get('catch_receipt_id')
        gross_weight = data.get('gross_weight')
        if not receipt_id or gross_weight is None:
            return {'error': 'catch_receipt_id and gross_weight are required'}
        receipt = request.env['aqua.catch.receipt'].sudo().browse(int(receipt_id))
        if not receipt.exists():
            return {'error': 'catch receipt not found'}
        receipt.write({'gross_weight': gross_weight})
        return {'success': True, 'receipt': receipt.name}


class AquaColdStorageController(http.Controller):

    @http.route('/aqua/coldstorage/sensor', type='json', auth='public', methods=['POST'], csrf=False)
    def sensor_webhook(self, **kwargs):
        """Receives IoT temperature sensor readings (Community-safe: no IoT Box app)."""
        data = request.get_json_data() if hasattr(request, 'get_json_data') else kwargs
        cold_room_id = data.get('cold_room_id')
        temperature = data.get('temperature')
        if not cold_room_id or temperature is None:
            return {'error': 'cold_room_id and temperature are required'}
        room = request.env['aqua.cold.room'].sudo().browse(int(cold_room_id))
        if not room.exists():
            return {'error': 'cold room not found'}
        log = request.env['aqua.temperature.log'].sudo().create({
            'cold_room_id': room.id,
            'temperature': temperature,
            'source': 'sensor',
        })
        return {'success': True, 'is_excursion': log.is_excursion}


class AquaPackingController(http.Controller):

    @http.route('/aqua/packing/scan', type='http', auth='user', website=True)
    def packing_scan_screen(self, **kwargs):
        """Handheld scan-to-pack / scan-to-palletize screen."""
        return request.render('aqua_food_processing.packing_scan_template', {})

    @http.route('/aqua/packing/scan/carton', type='json', auth='user', methods=['POST'], csrf=False)
    def scan_carton_item(self, barcode=None, pack_order_id=None, **kwargs):
        if not barcode or not pack_order_id:
            return {'error': 'barcode and pack_order_id are required'}
        carton = request.env['aqua.carton'].search([('barcode', '=', barcode)], limit=1)
        if not carton:
            return {'error': 'carton not found for barcode'}
        return {'success': True, 'carton': carton.name}


class AquaTraceabilityController(http.Controller):

    @http.route('/aqua/trace/lookup', type='http', auth='public', website=True)
    def public_trace_lookup(self, lot=None, **kwargs):
        """Public-facing consumer QR scan showing the product's journey."""
        trace_link = False
        if lot:
            trace_link = request.env['aqua.trace.link'].sudo().search(
                ['|', ('pallet_id.name', '=', lot), ('carton_id.name', '=', lot)], limit=1
            )
        return request.render('aqua_food_processing.trace_lookup_template', {
            'lot': lot,
            'trace_link': trace_link,
        })


class AquaPurchasePortalController(http.Controller):

    @http.route(['/my/purchase/<int:order_id>/update_shrimp_count'], type='json', auth='public', website=True)
    def portal_update_shrimp_count(self, order_id=None, access_token=None, **kw):
        """Vendor reports shrimp count per line from the RFQ portal page.

        Restricted to the RFQ's own vendor, and only while the order is still
        in 'sent' (RFQ Sent) state.
        """
        PurchaseOrder = request.env['purchase.order']
        try:
            order_sudo = PurchaseOrder.sudo().browse(order_id).exists()
        except (AccessError, MissingError):
            return {'error': 'not found'}

        if not order_sudo:
            return {'error': 'not found'}

        if access_token and order_sudo.access_token != access_token:
            return {'error': 'invalid access token'}

        if request.env.user._is_public() or request.env.user.partner_id != order_sudo.partner_id:
            return {'error': 'not allowed'}

        if order_sudo.state != 'sent':
            return {'error': 'order is no longer open for RFQ updates'}

        for id_str, count_str in kw.items():
            try:
                line_id = int(id_str)
                count = int(count_str)
            except (TypeError, ValueError):
                continue
            line = order_sudo.order_line.filtered(lambda l: l.id == line_id)
            if line:
                line.write({'shrimp_count': count})

        return {'success': True}