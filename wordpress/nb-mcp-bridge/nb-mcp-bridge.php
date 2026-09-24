<?php
/**
 * Plugin Name:       NB MCP Bridge
 * Plugin URI:        https://github.com/nobears/wp-fleet-mcp
 * Description:       Companion mu-plugin for wp-fleet-mcp. Exposes REST endpoints
 *                     (namespace nb-mcp/v1) for status, update management and role
 *                     information that WordPress core REST does not provide.
 * Version:           1.0.2
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            wp-fleet-mcp
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 *
 * @package NB_MCP_Bridge
 */

defined( 'ABSPATH' ) || exit;

// Reported by GET /nb-mcp/v1/status; keep in sync with the "Version" header above.
define( 'NB_MCP_BRIDGE_VERSION', '1.0.2' );

/**
 * Register all nb-mcp/v1 REST routes.
 */
function nb_mcp_bridge_register_routes() {
	// Shared arg schemas, reused across the routes below.
	$boolean_arg = static function ( $default = false ) {
		return array(
			'type'              => 'boolean',
			'required'          => false,
			'default'           => $default,
			'sanitize_callback' => 'rest_sanitize_boolean',
		);
	};

	$string_array_arg = array(
		'type'              => 'array',
		'required'          => true,
		'items'             => array( 'type' => 'string' ),
		'validate_callback' => 'nb_mcp_bridge_validate_string_array',
		'sanitize_callback' => 'nb_mcp_bridge_sanitize_string_array',
	);

	register_rest_route( 'nb-mcp/v1', '/status', array(
		'methods'             => WP_REST_Server::READABLE,
		'callback'            => 'nb_mcp_bridge_get_status',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'manage_options' ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates', array(
		'methods'             => WP_REST_Server::READABLE,
		'callback'            => 'nb_mcp_bridge_get_updates',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_plugins' ),
		'args'                => array( 'refresh' => $boolean_arg() ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/plugins', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_plugins',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_plugins' ),
		'args'                => array( 'plugins' => $string_array_arg ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/themes', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_themes',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_themes' ),
		'args'                => array( 'themes' => $string_array_arg ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/core', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_core',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_core' ),
		'args'                => array( 'allow_major' => $boolean_arg() ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/translations', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_translations',
		// Either capability is accepted, per the spec's "update_languages or update_plugins".
		'permission_callback' => nb_mcp_bridge_permission_callback( array( 'update_languages', 'update_plugins' ) ),
	) );

	register_rest_route( 'nb-mcp/v1', '/roles', array(
		'methods'             => WP_REST_Server::READABLE,
		'callback'            => 'nb_mcp_bridge_get_roles',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'list_users' ),
		'args'                => array( 'include_caps' => $boolean_arg() ),
	) );
}
add_action( 'rest_api_init', 'nb_mcp_bridge_register_routes' );

/**
 * Build a permission_callback requiring one of the given capabilities AND
 * (by default) Application Password authentication. Note: on multisite the
 * update_* capabilities are super-admin only (standard WP behaviour, see README).
 *
 * @param string|string[] $capabilities One or more capabilities; any one is sufficient.
 * @return callable REST permission_callback.
 */
function nb_mcp_bridge_permission_callback( $capabilities ) {
	$capabilities = (array) $capabilities;

	return function () use ( $capabilities ) {
		$has_capability = false;
		foreach ( $capabilities as $capability ) {
			if ( current_user_can( $capability ) ) {
				$has_capability = true;
				break;
			}
		}

		if ( ! $has_capability ) {
			return new WP_Error(
				'nb_mcp_forbidden',
				sprintf(
					/* translators: %s: comma separated list of WordPress capabilities. */
					__( 'This action requires one of the following capabilities: %s.', 'nb-mcp-bridge' ),
					implode( ', ', $capabilities )
				),
				array( 'status' => 403 )
			);
		}

		/**
		 * Filters whether nb-mcp-bridge routes require Application Password
		 * authentication in addition to the capability check. Default true.
		 *
		 * @param bool $require Whether an Application Password is required.
		 */
		$require_app_password = apply_filters( 'nb_mcp_bridge_require_app_password', true );

		if ( $require_app_password ) {
			$app_password = function_exists( 'rest_get_authenticated_app_password' )
				? rest_get_authenticated_app_password()
				: null;

			if ( empty( $app_password ) ) {
				return new WP_Error(
					'nb_mcp_forbidden',
					__( 'This endpoint requires authentication via a WordPress Application Password.', 'nb-mcp-bridge' ),
					array( 'status' => 403 )
				);
			}
		}

		return true;
	};
}

/**
 * Validate that a REST parameter is an array of non-empty strings.
 *
 * @param mixed  $value Raw parameter value.
 * @param string $param The parameter name (for the error message).
 * @return true|WP_Error
 */
function nb_mcp_bridge_validate_string_array( $value, $request, $param ) {
	if ( ! is_array( $value ) ) {
		return new WP_Error(
			'nb_mcp_invalid_params',
			sprintf(
				/* translators: %s: parameter name. */
				__( 'The "%s" parameter must be an array of strings.', 'nb-mcp-bridge' ),
				$param
			),
			array( 'status' => 400 )
		);
	}

	foreach ( $value as $item ) {
		if ( ! is_string( $item ) || '' === trim( $item ) ) {
			return new WP_Error(
				'nb_mcp_invalid_params',
				sprintf(
					/* translators: %s: parameter name. */
					__( 'The "%s" parameter must contain only non-empty strings.', 'nb-mcp-bridge' ),
					$param
				),
				array( 'status' => 400 )
			);
		}
	}

	return true;
}

/**
 * Sanitize an array of strings for use as a REST parameter.
 */
function nb_mcp_bridge_sanitize_string_array( $value ) {
	return array_map( 'sanitize_text_field', (array) $value );
}

/**
 * Guard for every write route: is file modification allowed on this install?
 *
 * @return true|WP_Error
 */
function nb_mcp_bridge_check_file_mods_allowed() {
	if ( defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS ) {
		return new WP_Error(
			'nb_mcp_file_mods_disabled',
			__( 'File modifications are disabled on this site (DISALLOW_FILE_MODS is true).', 'nb-mcp-bridge' ),
			array( 'status' => 409 )
		);
	}

	if ( function_exists( 'wp_is_file_mod_allowed' ) && ! wp_is_file_mod_allowed( 'nb_mcp_bridge' ) ) {
		return new WP_Error(
			'nb_mcp_file_mods_disabled',
			__( 'File modifications are disabled on this site.', 'nb-mcp-bridge' ),
			array( 'status' => 409 )
		);
	}

	return true;
}

/**
 * Load the wp-admin includes needed for plugin/theme introspection
 * (get_plugins(), is_plugin_active(), wp_get_theme() helpers, etc.).
 * Safe to call from any handler; require_once is idempotent.
 */
function nb_mcp_bridge_load_admin_includes() {
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	require_once ABSPATH . 'wp-admin/includes/theme.php';
}

/**
 * Load the wp-admin includes required by the upgrader classes and update helpers.
 */
function nb_mcp_bridge_load_upgrade_dependencies() {
	nb_mcp_bridge_load_admin_includes();
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/update.php';
	require_once ABSPATH . 'wp-admin/includes/misc.php';
	// Pulls in Plugin_Upgrader, Theme_Upgrader, Core_Upgrader,
	// Language_Pack_Upgrader and WP_Ajax_Upgrader_Skin.
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
}

/**
 * Ensure direct filesystem access, required by the upgrader classes.
 *
 * @return true|WP_Error
 */
function nb_mcp_bridge_ensure_filesystem() {
	if ( ! function_exists( 'WP_Filesystem' ) ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
	}

	ob_start();
	$credentials = request_filesystem_credentials( '', '', false, false, null );
	ob_end_clean();

	if ( false === $credentials || ! WP_Filesystem( $credentials ) ) {
		return new WP_Error(
			'nb_mcp_filesystem',
			__( 'Could not initialize the WordPress filesystem for direct access. Set FS_METHOD to "direct" in wp-config.php and ensure the web server user can write to wp-content.', 'nb-mcp-bridge' ),
			array( 'status' => 500 )
		);
	}

	return true;
}

/**
 * Drop the "error" key from a result row when it is empty (spec: `error?`).
 */
function nb_mcp_bridge_trim_empty_error( $result ) {
	if ( isset( $result['error'] ) && '' === $result['error'] ) {
		unset( $result['error'] );
	}

	return $result;
}

/**
 * GET /nb-mcp/v1/status
 */
function nb_mcp_bridge_get_status() {
	global $wpdb;

	nb_mcp_bridge_load_admin_includes();

	$active_theme = wp_get_theme();
	$all_plugins  = get_plugins();

	$active_plugins = (array) get_option( 'active_plugins', array() );
	if ( is_multisite() ) {
		$active_plugins = array_unique( array_merge( $active_plugins, array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) ) );
	}

	$response = array(
		'bridge_version' => NB_MCP_BRIDGE_VERSION,
		'wp_version'     => get_bloginfo( 'version' ),
		'php_version'    => PHP_VERSION,
		'mysql_version'  => is_callable( array( $wpdb, 'db_version' ) ) ? $wpdb->db_version() : '',
		'multisite'      => is_multisite(),
		'site_url'       => site_url(),
		'home_url'       => home_url(),
		'is_ssl'         => is_ssl(),
		'active_theme'   => array(
			'stylesheet' => $active_theme->get_stylesheet(),
			'name'       => $active_theme->get( 'Name' ),
			'version'    => $active_theme->get( 'Version' ),
		),
		'constants'      => array(
			'WP_DEBUG'            => defined( 'WP_DEBUG' ) && WP_DEBUG,
			'WP_DEBUG_DISPLAY'    => defined( 'WP_DEBUG_DISPLAY' ) && WP_DEBUG_DISPLAY,
			'DISALLOW_FILE_EDIT'  => defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT,
			'DISALLOW_FILE_MODS'  => defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS,
			'WP_AUTO_UPDATE_CORE' => defined( 'WP_AUTO_UPDATE_CORE' ) ? WP_AUTO_UPDATE_CORE : null,
		),
		'environment_type' => function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : 'production',
		'memory_limit'     => ini_get( 'memory_limit' ),
		'plugin_counts'    => array(
			'total'  => count( $all_plugins ),
			'active' => count( $active_plugins ),
		),
	);

	return rest_ensure_response( $response );
}

/**
 * GET /nb-mcp/v1/updates
 */
function nb_mcp_bridge_get_updates( WP_REST_Request $request ) {
	nb_mcp_bridge_load_upgrade_dependencies();

	if ( $request->get_param( 'refresh' ) ) {
		// Update checks can take a while on slow package mirrors.
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 0 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}

		delete_site_transient( 'update_plugins' );
		delete_site_transient( 'update_themes' );
		delete_site_transient( 'update_core' );

		wp_version_check();
		wp_update_plugins();
		wp_update_themes();
	}

	$installed_version = get_bloginfo( 'version' );

	// Include 'autoupdate' offers alongside 'upgrade' ones: get_core_updates()
	// drops 'autoupdate' unconditionally, which hides the same-branch
	// minor/security release on a site that is a major version behind. See
	// nb_mcp_bridge_get_core_update_offers() for the full explanation.
	$core = array();
	foreach ( nb_mcp_bridge_get_core_update_offers() as $update ) {
		$core[] = array(
			'current'  => $installed_version,
			'version'  => isset( $update->version ) ? $update->version : '',
			'response' => isset( $update->response ) ? $update->response : '',
			'locale'   => isset( $update->locale ) ? $update->locale : '',
			'type'     => nb_mcp_bridge_is_major_version_change( $installed_version, $update->current ) ? 'major' : 'minor',
		);
	}

	$auto_update_plugins = (array) get_option( 'auto_update_plugins', array() );
	$plugins             = array();

	foreach ( (array) get_plugin_updates() as $plugin_file => $plugin_data ) {
		$update  = isset( $plugin_data->update ) ? $plugin_data->update : null;
		$package = ( $update && ! empty( $update->package ) ) ? $update->package : '';

		$plugins[] = array(
			'plugin'            => $plugin_file,
			'name'              => isset( $plugin_data->Name ) ? $plugin_data->Name : '',
			'current_version'   => isset( $plugin_data->Version ) ? $plugin_data->Version : '',
			'new_version'       => ( $update && isset( $update->new_version ) ) ? $update->new_version : '',
			'package_available' => ( '' !== $package ),
			'requires_php'      => ( $update && isset( $update->requires_php ) ) ? $update->requires_php : '',
			'tested'            => ( $update && isset( $update->tested ) ) ? $update->tested : '',
			'auto_update'       => in_array( $plugin_file, $auto_update_plugins, true ),
		);
	}

	$themes = array();
	foreach ( (array) get_theme_updates() as $stylesheet => $theme_data ) {
		$update  = isset( $theme_data->update ) ? (array) $theme_data->update : array();
		$package = ! empty( $update['package'] ) ? $update['package'] : '';

		$themes[] = array(
			'stylesheet'        => $stylesheet,
			'name'              => $theme_data->get( 'Name' ),
			'current_version'   => $theme_data->get( 'Version' ),
			'new_version'       => isset( $update['new_version'] ) ? $update['new_version'] : '',
			'package_available' => ( '' !== $package ),
		);
	}

	$translation_updates = function_exists( 'wp_get_translation_updates' ) ? wp_get_translation_updates() : array();

	return rest_ensure_response(
		array(
			'checked_at'   => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'core'         => $core,
			'plugins'      => $plugins,
			'themes'       => $themes,
			'translations' => array( 'count' => count( (array) $translation_updates ) ),
		)
	);
}

/**
 * Resolve a single bulk_upgrade() item into [success, error]. Per WP_Upgrader::run(),
 * $item_result is an array of upgrade info on success, `true` if already up to date,
 * `false` on a fatal error (e.g. filesystem connection failure), or a WP_Error.
 *
 * @param mixed  $item_result Value from the upgrader's bulk_upgrade() return array.
 * @param string $from        Version before the upgrade.
 * @param string $to          Version after the upgrade.
 * @param object $skin        The WP_Upgrader_Skin used, for error messages.
 * @return array{0: bool, 1: string}
 */
function nb_mcp_bridge_upgrade_item_outcome( $item_result, $from, $to, $skin ) {
	if ( null === $item_result ) {
		// Defensive fallback: bulk_upgrade() returned no entry for this item.
		$success = ( $to !== $from );
		$error   = '';
	} elseif ( is_wp_error( $item_result ) ) {
		$success = false;
		$error   = $item_result->get_error_message();
	} else {
		$success = ( false !== $item_result );
		$error   = '';
	}

	if ( ! $success && '' === $error ) {
		$messages = $skin->get_error_messages();
		$error    = ! empty( $messages ) ? implode( ' ', (array) $messages ) : __( 'Update failed for an unknown reason.', 'nb-mcp-bridge' );
	}
	return array( $success, $error );
}

/**
 * Shared bulk-upgrade runner for /updates/plugins and /updates/themes. Runs
 * $upgrader_class::bulk_upgrade() over $items ('plugin'/'theme' $id_key rows),
 * using $exists_cb/$has_update_cb/$version_before_cb/$version_after_cb to
 * validate, skip items with nothing pending, and diff versions, with optional
 * $after_bulk_cb (once) and $per_item_cb (per id) hooks.
 *
 * @param callable $has_update_cb Given an id, returns true if the update
 *                                transient has a pending update for it.
 *                                Items without one are reported as
 *                                success:false, error "No update available"
 *                                without ever reaching bulk_upgrade().
 * @return array List of result rows, in $items order.
 */
function nb_mcp_bridge_run_bulk_upgrade( $items, $id_key, $exists_cb, $has_update_cb, $version_before_cb, $version_after_cb, $upgrader_class, $after_bulk_cb = null, $per_item_cb = null ) {
	$valid           = array();
	$results         = array();
	$versions_before = array();

	foreach ( $items as $id ) {
		if ( ! call_user_func( $exists_cb, $id ) ) {
			$results[ $id ] = array(
				$id_key   => $id,
				'success' => false,
				'from'    => '',
				'to'      => '',
				'error'   => sprintf(
					/* translators: %s: 'plugin' or 'theme'. */
					__( 'Unknown %s: not found on this site.', 'nb-mcp-bridge' ),
					$id_key
				),
			);
			continue;
		}

		$version_before = call_user_func( $version_before_cb, $id );

		if ( ! call_user_func( $has_update_cb, $id ) ) {
			$results[ $id ] = array(
				$id_key   => $id,
				'success' => false,
				'from'    => $version_before,
				'to'      => $version_before,
				'error'   => __( 'No update available.', 'nb-mcp-bridge' ),
			);
			continue;
		}

		$valid[]                = $id;
		$versions_before[ $id ] = $version_before;
	}

	if ( ! empty( $valid ) ) {
		$skin        = new WP_Ajax_Upgrader_Skin();
		$upgrader    = new $upgrader_class( $skin );
		$bulk_result = $upgrader->bulk_upgrade( $valid );

		if ( $after_bulk_cb ) {
			call_user_func( $after_bulk_cb );
		}

		foreach ( $valid as $id ) {
			$item_result = ( is_array( $bulk_result ) && isset( $bulk_result[ $id ] ) ) ? $bulk_result[ $id ] : null;
			$from        = $versions_before[ $id ];
			$to          = call_user_func( $version_after_cb, $id );

			list( $success, $error ) = nb_mcp_bridge_upgrade_item_outcome( $item_result, $from, $to, $skin );

			if ( $per_item_cb ) {
				call_user_func( $per_item_cb, $id );
			}

			$results[ $id ] = nb_mcp_bridge_trim_empty_error(
				array(
					$id_key   => $id,
					'success' => $success,
					'from'    => $from,
					'to'      => $to,
					'error'   => $error,
				)
			);
		}
	}

	$ordered = array();
	foreach ( $items as $id ) {
		if ( isset( $results[ $id ] ) ) {
			$ordered[] = $results[ $id ];
		}
	}

	return $ordered;
}

/**
 * POST /nb-mcp/v1/updates/plugins
 */
function nb_mcp_bridge_update_plugins( WP_REST_Request $request ) {
	$file_mods_check = nb_mcp_bridge_check_file_mods_allowed();
	if ( is_wp_error( $file_mods_check ) ) {
		return $file_mods_check;
	}

	nb_mcp_bridge_load_upgrade_dependencies();

	$fs_check = nb_mcp_bridge_ensure_filesystem();
	if ( is_wp_error( $fs_check ) ) {
		return $fs_check;
	}

	$requested = array_values( array_unique( (array) $request->get_param( 'plugins' ) ) );

	if ( function_exists( 'set_time_limit' ) ) {
		@set_time_limit( 0 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	}

	// Refresh the update transient first so packages (including premium ones
	// exposed only via the update transient filter) are known before upgrading.
	wp_update_plugins();

	$known_before    = get_plugins();
	$known_after     = array();
	$active_before   = array();
	$pending_updates = get_plugin_updates();

	foreach ( $requested as $plugin_file ) {
		$active_before[ $plugin_file ] = is_plugin_active( $plugin_file );
	}

	$results = nb_mcp_bridge_run_bulk_upgrade(
		$requested,
		'plugin',
		function ( $id ) use ( $known_before ) {
			return isset( $known_before[ $id ] );
		},
		function ( $id ) use ( $pending_updates ) {
			return isset( $pending_updates[ $id ] );
		},
		function ( $id ) use ( $known_before ) {
			return isset( $known_before[ $id ]['Version'] ) ? $known_before[ $id ]['Version'] : '';
		},
		function ( $id ) use ( &$known_after ) {
			return isset( $known_after[ $id ]['Version'] ) ? $known_after[ $id ]['Version'] : '';
		},
		'Plugin_Upgrader',
		function () use ( &$known_after ) {
			wp_clean_plugins_cache( true );
			$known_after = get_plugins();
		},
		function ( $id ) use ( $active_before ) {
			// Re-activate if the upgrade process deactivated a plugin that was active.
			if ( ! empty( $active_before[ $id ] ) && ! is_plugin_active( $id ) && file_exists( WP_PLUGIN_DIR . '/' . $id ) ) {
				activate_plugin( $id, '', is_plugin_active_for_network( $id ), true );
			}
		}
	);

	return rest_ensure_response( array( 'results' => $results ) );
}

/**
 * POST /nb-mcp/v1/updates/themes
 */
function nb_mcp_bridge_update_themes( WP_REST_Request $request ) {
	$file_mods_check = nb_mcp_bridge_check_file_mods_allowed();
	if ( is_wp_error( $file_mods_check ) ) {
		return $file_mods_check;
	}

	nb_mcp_bridge_load_upgrade_dependencies();

	$fs_check = nb_mcp_bridge_ensure_filesystem();
	if ( is_wp_error( $fs_check ) ) {
		return $fs_check;
	}

	$requested = array_values( array_unique( (array) $request->get_param( 'themes' ) ) );

	if ( function_exists( 'set_time_limit' ) ) {
		@set_time_limit( 0 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	}

	wp_update_themes();

	$pending_updates = get_theme_updates();

	$results = nb_mcp_bridge_run_bulk_upgrade(
		$requested,
		'theme',
		function ( $id ) {
			return wp_get_theme( $id )->exists();
		},
		function ( $id ) use ( $pending_updates ) {
			return isset( $pending_updates[ $id ] );
		},
		function ( $id ) {
			return wp_get_theme( $id )->get( 'Version' );
		},
		function ( $id ) {
			return wp_get_theme( $id )->get( 'Version' );
		},
		'Theme_Upgrader',
		function () {
			wp_clean_themes_cache( true );
		}
	);

	return rest_ensure_response( array( 'results' => $results ) );
}

/**
 * Is upgrading from $from to $to a major (x.y) version change, e.g. 6.4 -> 6.5?
 *
 * @return bool
 */
function nb_mcp_bridge_is_major_version_change( $from, $to ) {
	$from_parts = explode( '.', $from );
	$to_parts   = explode( '.', $to );

	$from_major = isset( $from_parts[0], $from_parts[1] ) ? $from_parts[0] . '.' . $from_parts[1] : $from;
	$to_major   = isset( $to_parts[0], $to_parts[1] ) ? $to_parts[0] . '.' . $to_parts[1] : $to;

	return $from_major !== $to_major;
}

/**
 * Fetch every real core update offer, both 'upgrade' and 'autoupdate'
 * responses, deduplicated to one entry per (response, target version) pair
 * by locale preference.
 *
 * get_core_updates() cannot be used for this: per wp-admin/includes/update.php
 * (~line 64) it unconditionally does `if ( 'autoupdate' === $update->response )
 * { continue; }` before its $options (including 'dismissed') are even
 * consulted, so every 'autoupdate' offer is dropped no matter what is passed
 * in. On a site a full major version behind, the same-branch minor/security
 * release is served as an 'autoupdate' offer (WP only proposes an 'upgrade'
 * for the newest major branch), so relying on get_core_updates() alone
 * silently hides the very release /updates/core should be able to install by
 * default. Read the raw update_core site transient instead, which carries
 * every offer WordPress fetched from the API, and filter/dedupe ourselves.
 *
 * @return object[] Offers, one per distinct (response, current) pair.
 */
function nb_mcp_bridge_get_core_update_offers() {
	$transient = get_site_transient( 'update_core' );

	if ( ! isset( $transient->updates ) || ! is_array( $transient->updates ) ) {
		return array();
	}

	$grouped = array();

	foreach ( $transient->updates as $update ) {
		if ( ! is_object( $update ) || ! isset( $update->response, $update->current ) ) {
			continue;
		}

		if ( ! in_array( $update->response, array( 'upgrade', 'autoupdate' ), true ) ) {
			continue; // Skip 'latest' (no-op), 'development', etc.
		}

		$key = $update->response . '|' . $update->current;

		if ( ! isset( $grouped[ $key ] ) ) {
			$grouped[ $key ] = array();
		}

		$grouped[ $key ][] = $update;
	}

	$preferred_locale = get_locale();
	$offers           = array();

	foreach ( $grouped as $variants ) {
		$offers[] = nb_mcp_bridge_pick_locale_variant( $variants, $preferred_locale );
	}

	return $offers;
}

/**
 * From several locale variants of the same (response, target version)
 * offer, pick the site's own locale, then en_US, then whatever is left.
 *
 * @param object[] $variants
 * @return object
 */
function nb_mcp_bridge_pick_locale_variant( $variants, $preferred_locale ) {
	foreach ( $variants as $variant ) {
		if ( isset( $variant->locale ) && $preferred_locale === $variant->locale ) {
			return $variant;
		}
	}

	foreach ( $variants as $variant ) {
		if ( isset( $variant->locale ) && 'en_US' === $variant->locale ) {
			return $variant;
		}
	}

	return $variants[0];
}

/**
 * Highest-versioned offer among a non-empty list, by target version.
 *
 * @param object[] $offers
 * @return object
 */
function nb_mcp_bridge_highest_offer( $offers ) {
	usort(
		$offers,
		static function ( $a, $b ) {
			return version_compare( $a->current, $b->current );
		}
	);

	return end( $offers );
}

/**
 * Pick the core update offer to install for POST /updates/core.
 *
 * When $allow_major is false, only offers in the installed version's own
 * x.y branch (minor/security releases — typically 'autoupdate' responses,
 * but an 'upgrade' can also land same-branch) are eligible, and the highest
 * of those is returned. When $allow_major is true, the highest offer overall
 * (any branch) is returned. Offers that are not actually newer than the
 * installed version are ignored.
 *
 * @param bool $allow_major
 * @return array{0: object|null, 1: object|null} [chosen offer or null,
 *                                                 highest blocking
 *                                                 major-branch offer if the
 *                                                 caller should be told to
 *                                                 pass allow_major, else
 *                                                 null].
 */
function nb_mcp_bridge_select_core_update( $allow_major ) {
	$installed   = get_bloginfo( 'version' );
	$same_branch  = array();
	$other_branch = array();

	foreach ( nb_mcp_bridge_get_core_update_offers() as $offer ) {
		if ( version_compare( $offer->current, $installed, '<=' ) ) {
			continue; // Not actually newer than what's installed.
		}

		if ( nb_mcp_bridge_is_major_version_change( $installed, $offer->current ) ) {
			$other_branch[] = $offer;
		} else {
			$same_branch[] = $offer;
		}
	}

	if ( $allow_major ) {
		$candidates = array_merge( $same_branch, $other_branch );

		return empty( $candidates ) ? array( null, null ) : array( nb_mcp_bridge_highest_offer( $candidates ), null );
	}

	if ( ! empty( $same_branch ) ) {
		return array( nb_mcp_bridge_highest_offer( $same_branch ), null );
	}

	$blocking = empty( $other_branch ) ? null : nb_mcp_bridge_highest_offer( $other_branch );

	return array( null, $blocking );
}

/**
 * POST /nb-mcp/v1/updates/core
 */
function nb_mcp_bridge_update_core( WP_REST_Request $request ) {
	$file_mods_check = nb_mcp_bridge_check_file_mods_allowed();
	if ( is_wp_error( $file_mods_check ) ) {
		return $file_mods_check;
	}

	nb_mcp_bridge_load_upgrade_dependencies();

	$fs_check = nb_mcp_bridge_ensure_filesystem();
	if ( is_wp_error( $fs_check ) ) {
		return $fs_check;
	}

	$allow_major = (bool) $request->get_param( 'allow_major' );

	if ( function_exists( 'set_time_limit' ) ) {
		@set_time_limit( 0 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	}

	wp_version_check();

	$from = get_bloginfo( 'version' );

	list( $update, $blocking_major ) = nb_mcp_bridge_select_core_update( $allow_major );

	if ( ! $update ) {
		if ( $blocking_major ) {
			return new WP_Error(
				'nb_mcp_major_update_blocked',
				sprintf(
					/* translators: 1: target version, 2: current version. */
					__( 'Update to %1$s is a major version change from %2$s. Pass allow_major=true to proceed.', 'nb-mcp-bridge' ),
					$blocking_major->current,
					$from
				),
				array( 'status' => 409 )
			);
		}

		return rest_ensure_response(
			array(
				'success' => false,
				'from'    => $from,
				'to'      => $from,
				'error'   => __( 'No core update is available.', 'nb-mcp-bridge' ),
			)
		);
	}

	// $update->current is the offer's TARGET version (see
	// nb_mcp_bridge_get_core_update_offers() for why we read the raw
	// transient instead of get_core_updates()).
	$to_version = $update->current;

	$skin     = new WP_Ajax_Upgrader_Skin();
	$upgrader = new Core_Upgrader( $skin );
	$result   = $upgrader->upgrade( $update );

	// $wp_version is only refreshed for the current request by re-reading
	// wp-includes/version.php, since core files just changed on disk;
	// get_bloginfo('version') would still return the pre-upgrade value here.
	// Declared as a local variable, not the global, on purpose.
	$wp_version = $from;
	require ABSPATH . WPINC . '/version.php';
	$to = $wp_version;

	$success = ! is_wp_error( $result ) && ( $to !== $from );
	$error   = '';

	if ( is_wp_error( $result ) ) {
		$error = $result->get_error_message();
	} elseif ( ! $success ) {
		$messages = $skin->get_error_messages();
		$error    = ! empty( $messages ) ? implode( ' ', (array) $messages ) : __( 'Core update did not complete.', 'nb-mcp-bridge' );
	}

	return rest_ensure_response(
		nb_mcp_bridge_trim_empty_error(
			array(
				'success' => $success,
				'from'    => $from,
				'to'      => $to,
				'error'   => $error,
			)
		)
	);
}

/**
 * POST /nb-mcp/v1/updates/translations
 */
function nb_mcp_bridge_update_translations() {
	$file_mods_check = nb_mcp_bridge_check_file_mods_allowed();
	if ( is_wp_error( $file_mods_check ) ) {
		return $file_mods_check;
	}

	nb_mcp_bridge_load_upgrade_dependencies();

	$fs_check = nb_mcp_bridge_ensure_filesystem();
	if ( is_wp_error( $fs_check ) ) {
		return $fs_check;
	}

	if ( function_exists( 'set_time_limit' ) ) {
		@set_time_limit( 0 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	}

	wp_version_check();
	wp_update_plugins();
	wp_update_themes();

	$updates = wp_get_translation_updates();

	if ( empty( $updates ) ) {
		return rest_ensure_response(
			array(
				'success' => true,
				'count'   => 0,
			)
		);
	}

	$skin     = new WP_Ajax_Upgrader_Skin();
	$upgrader = new Language_Pack_Upgrader( $skin );
	$result   = $upgrader->bulk_upgrade( $updates );

	// bulk_upgrade() returns an array of per-item WP_Upgrader::run() results
	// (an array on success, `false`/WP_Error on failure), `true` if there was
	// nothing to do, `false` on a fatal filesystem error, or a WP_Error.
	$error     = '';
	$succeeded = 0;

	if ( is_wp_error( $result ) ) {
		$error = $result->get_error_message();
	} elseif ( is_array( $result ) ) {
		foreach ( $result as $item_result ) {
			if ( is_wp_error( $item_result ) || false === $item_result ) {
				if ( '' === $error && is_wp_error( $item_result ) ) {
					$error = $item_result->get_error_message();
				}
				continue;
			}
			++$succeeded;
		}
	} elseif ( true === $result ) {
		$succeeded = count( $updates );
	}

	$success = ( '' === $error ) && ( $succeeded === count( $updates ) );

	if ( ! $success && '' === $error ) {
		$messages = $skin->get_error_messages();
		$error    = ! empty( $messages ) ? implode( ' ', (array) $messages ) : __( 'Translation update did not complete.', 'nb-mcp-bridge' );
	}

	return rest_ensure_response(
		nb_mcp_bridge_trim_empty_error(
			array(
				'success' => $success,
				'count'   => $succeeded,
				'error'   => $error,
			)
		)
	);
}

/**
 * GET /nb-mcp/v1/roles
 */
function nb_mcp_bridge_get_roles( WP_REST_Request $request ) {
	$include_caps = (bool) $request->get_param( 'include_caps' );

	$wp_roles    = wp_roles();
	$user_counts = count_users();
	$by_role     = isset( $user_counts['avail_roles'] ) ? $user_counts['avail_roles'] : array();

	$roles = array();

	foreach ( $wp_roles->roles as $slug => $role_data ) {
		$role_entry = array(
			'slug'       => $slug,
			'name'       => translate_user_role( $role_data['name'] ),
			'user_count' => isset( $by_role[ $slug ] ) ? (int) $by_role[ $slug ] : 0,
		);

		if ( $include_caps ) {
			$role_entry['capabilities'] = array_keys( array_filter( (array) $role_data['capabilities'] ) );
		}

		$roles[] = $role_entry;
	}

	return rest_ensure_response( array( 'roles' => $roles ) );
}
