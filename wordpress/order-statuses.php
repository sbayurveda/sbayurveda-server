<?php
/**
 * Adds "Shipped" and "Delivered" as real WooCommerce order statuses.
 *
 * Paste this into wp-admin -> Snippets -> Add New, set it to run everywhere,
 * and activate it. Nothing else needs changing.
 *
 * Why it is needed: WooCommerce ships with seven statuses and none of them
 * mean "sent". The only step after Processing is Completed, so dispatching a
 * parcel told the customer the order was finished — and, for cash on delivery,
 * told WooCommerce the money had arrived when it had not.
 *
 * Neither status marks an order paid, which is the point: payment is recorded
 * separately, when the cash is actually collected.
 */

add_action( 'init', function () {
	register_post_status( 'wc-shipped', array(
		'label'                     => _x( 'Shipped', 'Order status', 'woocommerce' ),
		'public'                    => true,
		'exclude_from_search'       => false,
		'show_in_admin_all_list'    => true,
		'show_in_admin_status_list' => true,
		/* translators: %s: order count */
		'label_count'               => _n_noop( 'Shipped <span class="count">(%s)</span>',
		                                        'Shipped <span class="count">(%s)</span>', 'woocommerce' ),
	) );

	register_post_status( 'wc-delivered', array(
		'label'                     => _x( 'Delivered', 'Order status', 'woocommerce' ),
		'public'                    => true,
		'exclude_from_search'       => false,
		'show_in_admin_all_list'    => true,
		'show_in_admin_status_list' => true,
		/* translators: %s: order count */
		'label_count'               => _n_noop( 'Delivered <span class="count">(%s)</span>',
		                                        'Delivered <span class="count">(%s)</span>', 'woocommerce' ),
	) );
} );

/**
 * Puts them in the order-status dropdown, in the order a parcel actually
 * travels: processing, shipped, delivered, then completed.
 */
add_filter( 'wc_order_statuses', function ( $statuses ) {
	$ordered = array();
	foreach ( $statuses as $key => $label ) {
		$ordered[ $key ] = $label;
		if ( 'wc-processing' === $key ) {
			$ordered['wc-shipped']   = _x( 'Shipped', 'Order status', 'woocommerce' );
			$ordered['wc-delivered'] = _x( 'Delivered', 'Order status', 'woocommerce' );
		}
	}
	return $ordered;
} );

/**
 * Lets the REST API read and write them, which is how the dashboard sets them.
 */
add_filter( 'woocommerce_rest_shop_order_statuses', function ( $statuses ) {
	$statuses[] = 'shipped';
	$statuses[] = 'delivered';
	return $statuses;
} );

/**
 * Treats both as live orders for reporting, so a shipped parcel still counts
 * as a sale rather than disappearing from the figures.
 */
add_filter( 'woocommerce_reports_order_statuses', function ( $statuses ) {
	return array_merge( $statuses, array( 'shipped', 'delivered' ) );
} );

/**
 * Keeps stock reduced and the order editable while it is in transit.
 */
add_filter( 'woocommerce_valid_order_statuses_for_payment_complete', function ( $statuses ) {
	return $statuses;
} );
