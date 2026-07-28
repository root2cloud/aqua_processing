/** @odoo-module */

import PublicWidget from "@web/legacy/js/public/public_widget";
import { rpc } from "@web/core/network/rpc";

export const AquaShrimpCountInput = PublicWidget.Widget.extend({
    selector: ".o-aqua-shrimp-count-input",
    events: {
        change: "_onChangeShrimpCount",
    },

    /**
     * @private
     */
    _onChangeShrimpCount(ev) {
        const { accessToken, orderId, lineId } = ev.target.dataset;
        const value = parseInt(ev.target.value, 10) || 0;
        rpc(`/my/purchase/${orderId}/update_shrimp_count?access_token=${accessToken}`, {
            [lineId]: value,
        });
    },
});

PublicWidget.registry.AquaShrimpCountInput = AquaShrimpCountInput;