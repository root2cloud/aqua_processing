import json

from odoo import http
from odoo.http import request


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
