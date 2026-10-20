<?php
/**
 * Adds "Shipped" and "Delivered" as real WooCommerce order statuses.
 *
 * Paste into wp-admin -> Snippets -> Add New, choose "Run everywhere", Save
 * and Activate. Nothing else needs changing, and nothing existing is removed:
 * Processing, Completed and the rest stay exactly as they are.
 *
 * Why: WooCommerce has seven statuses and none mean "sent". The only step
 * after Processing was Completed, so dispatching a parcel told the customer
 * the order was finished and told WooCommerce a cash-on-delivery order had
 * been paid. Neither new status marks an order paid.
 */

add_action( 'init', function () {
	foreach ( array( 'shipped' => 'Shipped', 'delivered' => 'Delivered' ) as $slug => $label ) {
		register_post_status( 'wc-' . $slug, array(
			'label'                     => $label,
			'public'                    => true,
			'show_in_admin_all_list'    => true,
			'show_in_admin_status_list' => true,
			'label_count'               => _n_noop(
				$label . ' <span class="count">(%s)</span>',
				$label . ' <span class="count">(%s)</span>'
			),
		) );
	}
} );

// Put them in the dropdown in the order a parcel actually travels.
add_filter( 'wc_order_statuses', function ( $statuses ) {
	$out = array();
	foreach ( $statuses as $key => $label ) {
		$out[ $key ] = $label;
		if ( 'wc-processing' === $key ) {
			$out['wc-shipped']   = 'Shipped';
			$out['wc-delivered'] = 'Delivered';
		}
	}
	return $out;
} );

// Let the REST API read and write them — this is what the dashboard uses.
add_filter( 'woocommerce_rest_shop_order_statuses', function ( $statuses ) {
	$statuses[] = 'shipped';
	$statuses[] = 'delivered';
	return $statuses;
} );

// Keep them counting as real sales in WooCommerce's own reports.
add_filter( 'woocommerce_reports_order_statuses', function ( $statuses ) {
	return array_merge( $statuses, array( 'shipped', 'delivered' ) );
} );
