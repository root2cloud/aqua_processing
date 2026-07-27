{
    'name': 'Aqua Food Processing Management',
    'version': '18.0.1.0.0',
    'category': 'Manufacturing',
    'summary': 'Seafood / Aqua Food Processing ERP - Procurement to Export Traceability',
    'description': """
        Aqua Food Processing Management System
        =======================================
        Single unified module covering the full catch-to-customer flow:
        * Vendor / market procurement of raw catch (any aquatic species)
        * Plant receiving, weighment, source grading
        * Processing (extends mrp) with yield and by-product tracking
        * Seafood-specific quality control (sensory, chemical, microbiological)
        * Cold storage, blast freezing, temperature logging
        * Packing, carton/pallet building, labeling
        * Vendor-level batch traceability with public QR lookup
        * Export logistics and India-specific export documentation
        * Cross-module KPI dashboards

        Architecture: internal functional-area folders instead of separate
        addons, matching the university_management project's monolithic
        structure and conventions (smart buttons, sequences, automated
        actions, reset-to-draft pattern).
    """,
    'author': 'R',
    'depends': [
        'base', 'mail', 'contacts', 'product', 'stock', 'purchase', 'mrp',
        'sale', 'sale_management', 'account', 'maintenance', 'barcodes',
        'hr', 'l10n_in',
    ],
    'data': [
        # security
        'security/aqua_security_groups.xml',
        'security/ir.model.access.csv',
        'security/aqua_record_rules.xml',
        # data
        'data/aqua_sequences.xml',
        'data/aqua_cron.xml',
        'data/aqua_email_templates.xml',
        # base
        'views/base/res_partner_views.xml',
        'views/base/product_template_views.xml',
        'views/base/aqua_species_views.xml',
        'views/base/aqua_grading_standard_views.xml',
        'views/base/aqua_harvest_method_views.xml',
        'views/base/aqua_certifying_body_views.xml',
        # procurement
        'views/procurement/aqua_catch_receipt_views.xml',
        'views/procurement/aqua_vendor_rate_contract_views.xml',
        'wizard/procurement/aqua_grade_catch_wizard_views.xml',
        # processing
        'views/processing/aqua_processing_order_views.xml',
        # quality
        'views/quality/aqua_quality_test_views.xml',
        'views/quality/aqua_certificate_of_analysis_views.xml',
        'wizard/quality/aqua_issue_coa_wizard_views.xml',
        # coldstorage
        'views/coldstorage/aqua_cold_room_views.xml',
        'views/coldstorage/aqua_temperature_log_views.xml',
        'views/coldstorage/aqua_blast_freeze_cycle_views.xml',
        # packing
        'views/packing/aqua_pack_order_views.xml',
        'views/packing/aqua_carton_views.xml',
        'views/packing/aqua_pallet_views.xml',
        'wizard/packing/aqua_build_carton_wizard_views.xml',
        'wizard/packing/aqua_build_pallet_wizard_views.xml',
        # traceability
        'views/traceability/aqua_trace_link_views.xml',
        'wizard/traceability/aqua_trace_query_wizard_views.xml',
        'templates/traceability/trace_lookup_templates.xml',
        # export logistics
        'views/export_logistics/aqua_shipment_views.xml',
        'views/export_logistics/aqua_container_views.xml',
        'views/export_logistics/aqua_export_document_views.xml',
        'wizard/export_logistics/aqua_stuff_container_wizard_views.xml',
        # dashboard
        'views/dashboard/aqua_dashboard_views.xml',
        # reports
        'report/aqua_reports.xml',
        # menus (loaded last, references actions above)
        'views/aqua_menus.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'aqua_food_processing/static/src/js/dashboard.js',
            'aqua_food_processing/static/src/xml/dashboard_templates.xml',
            'aqua_food_processing/static/src/css/dashboard.css',
        ],
    },
    'installable': True,
    'application': True,
    'license': 'LGPL-3',
}
