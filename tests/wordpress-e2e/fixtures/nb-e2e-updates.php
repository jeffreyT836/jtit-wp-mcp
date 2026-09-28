<?php
/**
 * Test-only mu-plugin: offers an update for the "nb-e2e-test" plugin whose package
 * is chosen by the `nb_e2e_offer` option ("good" → 1.1, "fatal" → 1.2 that breaks
 * the site). Lets the e2e script exercise the bridge's safe update flow offline.
 */

add_filter(
	'site_transient_update_plugins',
	function ( $transient ) {
		$offer = get_option( 'nb_e2e_offer', '' );
		if ( '' === $offer || ! is_object( $transient ) ) {
			return $transient;
		}
		$version = 'fatal' === $offer ? '1.2.0' : '1.1.0';
		$transient->response['nb-e2e-test/nb-e2e-test.php'] = (object) array(
			'slug'        => 'nb-e2e-test',
			'plugin'      => 'nb-e2e-test/nb-e2e-test.php',
			'new_version' => $version,
			'package'     => home_url( '/wp-content/uploads/nb-e2e-test-' . $version . '.zip' ),
			'url'         => '',
		);
		return $transient;
	}
);

// Keep wordpress.org out of the test (no network needed, no real updates offered).
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	return false !== strpos( $url, 'api.wordpress.org' ) ? new WP_Error( 'nb_e2e_offline', 'offline' ) : $pre;
}, 10, 3 );

// Front-end-only breakage (REST keeps working), to test the pre-update health gate.
add_action( 'template_redirect', function () {
	if ( get_option( 'nb_e2e_break_front' ) ) {
		nb_e2e_front_end_is_broken();
	}
} );
