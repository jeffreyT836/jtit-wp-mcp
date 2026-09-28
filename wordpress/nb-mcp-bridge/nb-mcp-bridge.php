<?php
/**
 * Plugin Name:       NB MCP Bridge
 * Plugin URI:        https://github.com/nobears/wp-fleet-mcp
 * Description:       Companion mu-plugin for wp-fleet-mcp. Exposes REST endpoints
 *                     (namespace nb-mcp/v1) for status, update management and role
 *                     information that WordPress core REST does not provide.
 * Version:           1.1.0
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
define( 'NB_MCP_BRIDGE_VERSION', '1.1.0' );

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

	// Safe updates (1.1.0): backup + health check + automatic restore.
	$safe_args = array(
		'safe'         => $boolean_arg(),
		'health_paths' => array(
			'type'              => 'array',
			'required'          => false,
			'default'           => array(),
			'items'             => array( 'type' => 'string' ),
			'validate_callback' => 'nb_mcp_bridge_validate_health_paths',
		),
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
		'args'                => array_merge( array( 'plugins' => $string_array_arg ), $safe_args ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/themes', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_themes',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_themes' ),
		'args'                => array_merge( array( 'themes' => $string_array_arg ), $safe_args ),
	) );

	register_rest_route( 'nb-mcp/v1', '/updates/core', array(
		'methods'             => WP_REST_Server::CREATABLE,
		'callback'            => 'nb_mcp_bridge_update_core',
		'permission_callback' => nb_mcp_bridge_permission_callback( 'update_core' ),
		'args'                => array_merge( array( 'allow_major' => $boolean_arg() ), $safe_args ),
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
 * Forbid any shared cache (CDN, edge or page cache such as Kinsta/Cloudflare) from storing
 * nb-mcp/v1 responses. They are per-user and authenticated; a cached copy would be served
 * to anonymous visitors. Applies to errors too (e.g. a 403 or a stale 404), so a cached
 * error can never mask the real answer either.
 *
 * @param WP_REST_Response $response Result to send to the client.
 * @param WP_REST_Server   $server   Server instance.
 * @param WP_REST_Request  $request  Request used to generate the response.
 * @return WP_REST_Response
 */
function nb_mcp_bridge_no_cache_headers( $response, $server, $request ) {
	if ( $response instanceof WP_REST_Response && 0 === strpos( $request->get_route(), '/nb-mcp/v1' ) ) {
		$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private' );
		$response->header( 'Pragma', 'no-cache' );
		$response->header( 'Expires', '0' );
		$response->header( 'Vary', 'Authorization' );
	}
	return $response;
}
add_filter( 'rest_post_dispatch', 'nb_mcp_bridge_no_cache_headers', 10, 3 );

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
		'features'       => array( 'safe_updates' ),
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
				$id_key     => $id,
				'success'   => false,
				'from'      => $version_before,
				'to'        => $version_before,
				'error'     => __( 'No update available.', 'nb-mcp-bridge' ),
				'no_update' => true,
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

	$run = function ( $items ) use ( &$known_after, $known_before, $pending_updates, $active_before ) {
			return nb_mcp_bridge_run_bulk_upgrade(
			$items,
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
	};

	if ( ! $request->get_param( 'safe' ) ) {
		return rest_ensure_response( array( 'results' => $run( $requested ) ) );
	}

	$paths    = (array) $request->get_param( 'health_paths' );
	$baseline = nb_mcp_bridge_safe_baseline( $paths );
	if ( is_wp_error( $baseline ) ) {
		return $baseline;
	}
	$results = array();
	foreach ( $requested as $plugin_file ) {
		$results[] = nb_mcp_bridge_safe_update_item(
			'plugin',
			$plugin_file,
			$baseline,
			$paths,
			function () use ( $run, $plugin_file ) {
				$rows = $run( array( $plugin_file ) );
				return $rows[0];
			},
			function () use ( $plugin_file, $active_before ) {
				wp_clean_plugins_cache( true );
				if ( ! empty( $active_before[ $plugin_file ] ) && ! is_plugin_active( $plugin_file ) && file_exists( WP_PLUGIN_DIR . '/' . $plugin_file ) ) {
					activate_plugin( $plugin_file, '', is_plugin_active_for_network( $plugin_file ), true );
				}
			}
		);
	}
	nb_mcp_bridge_finish_backup_run();

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

	$run = function ( $items ) use ( $pending_updates ) {
			return nb_mcp_bridge_run_bulk_upgrade(
			$items,
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
	};

	if ( ! $request->get_param( 'safe' ) ) {
		return rest_ensure_response( array( 'results' => $run( $requested ) ) );
	}

	$paths    = (array) $request->get_param( 'health_paths' );
	$baseline = nb_mcp_bridge_safe_baseline( $paths );
	if ( is_wp_error( $baseline ) ) {
		return $baseline;
	}
	$results = array();
	foreach ( $requested as $stylesheet ) {
		$results[] = nb_mcp_bridge_safe_update_item(
			'theme',
			$stylesheet,
			$baseline,
			$paths,
			function () use ( $run, $stylesheet ) {
				$rows = $run( array( $stylesheet ) );
				return $rows[0];
			},
			function () {
				wp_clean_themes_cache( true );
			}
		);
	}
	nb_mcp_bridge_finish_backup_run();

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
				'success'   => false,
				'from'      => $from,
				'to'        => $from,
				'error'     => __( 'No core update is available.', 'nb-mcp-bridge' ),
				'no_update' => true,
			)
		);
	}

	// $update->current is the offer's TARGET version (see
	// nb_mcp_bridge_get_core_update_offers() for why we read the raw
	// transient instead of get_core_updates()).
	$to_version = $update->current;

	$safe       = (bool) $request->get_param( 'safe' );
	$paths      = (array) $request->get_param( 'health_paths' );
	$is_major   = nb_mcp_bridge_is_major_version_change( $from, $to_version );
	$baseline   = null;
	$backup_dir = null;
	$log_mark   = null;
	$db_before  = get_option( 'db_version' );

	if ( $safe ) {
		$baseline = nb_mcp_bridge_safe_baseline( $paths );
		if ( is_wp_error( $baseline ) ) {
			return $baseline;
		}
		// Major updates are only checked, never automatically restored.
		if ( ! $is_major ) {
			$backup_dir = nb_mcp_bridge_backup_core();
			if ( is_wp_error( $backup_dir ) ) {
				return rest_ensure_response( array( 'success' => false, 'from' => $from, 'to' => $from, 'error' => 'Backup failed, update not run: ' . $backup_dir->get_error_message(), 'backup' => 'failed', 'rolled_back' => false ) );
			}
		}
		$log_mark = nb_mcp_bridge_error_log_mark();
	}

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

	$row = array(
		'success' => $success,
		'from'    => $from,
		'to'      => $to,
		'error'   => $error,
	);
	if ( $safe ) {
		$row = nb_mcp_bridge_safe_core_outcome( $row, $paths, $baseline, $log_mark, $backup_dir, $is_major, $db_before );
		nb_mcp_bridge_finish_backup_run();
	}

	return rest_ensure_response( nb_mcp_bridge_trim_empty_error( $row ) );
}

/**
 * Backs up WordPress core files (wp-admin, wp-includes, root PHP files except
 * wp-config.php) before a minor core update.
 *
 * @return string|WP_Error Backup directory.
 */
function nb_mcp_bridge_backup_core() {
	global $wp_filesystem;
	$run_dir = nb_mcp_bridge_backup_run_dir();
	if ( is_wp_error( $run_dir ) ) {
		return $run_dir;
	}
	$dir = $run_dir . '/core';
	foreach ( nb_mcp_bridge_core_entries() as $entry ) {
		$copied = nb_mcp_bridge_copy_path( ABSPATH . $entry, $dir . '/' . $entry );
		if ( is_wp_error( $copied ) ) {
			$wp_filesystem->delete( $dir, true );
			return $copied;
		}
	}
	return $dir;
}

/**
 * Health check after a core update and, for minor updates, restore on failure.
 */
function nb_mcp_bridge_safe_core_outcome( $row, $paths, $baseline, $log_mark, $backup_dir, $is_major, $db_before ) {
	global $wp_filesystem;

	$health = nb_mcp_bridge_health_check( $paths, $baseline, $log_mark );
	$row    = array_merge( $row, array( 'backup' => $backup_dir ? 'created' : 'none', 'health' => $health, 'rolled_back' => false ) );

	if ( $health['ok'] ) {
		if ( $backup_dir ) {
			$wp_filesystem->delete( $backup_dir, true );
		}
		return $row;
	}

	if ( ! $backup_dir ) {
		$row['success']        = false;
		$row['rollback_error'] = 'Site unhealthy after a major core update. Major updates are not restored automatically; check the site now.';
		return $row;
	}

	$restore_error = null;
	foreach ( nb_mcp_bridge_core_entries() as $entry ) {
		if ( ! $wp_filesystem->exists( $backup_dir . '/' . $entry ) ) {
			// A root PHP file the update added (never wp-config.php, see core_entries()).
			if ( '.php' === substr( $entry, -4 ) ) {
				$wp_filesystem->delete( ABSPATH . $entry );
			}
			continue;
		}
		$restored = nb_mcp_bridge_restore_path( $backup_dir . '/' . $entry, ABSPATH . $entry );
		if ( is_wp_error( $restored ) ) {
			$restore_error = $restored->get_error_message();
		}
	}
	$after = nb_mcp_bridge_health_check( $paths, $baseline );

	$row['success']     = false;
	$row['to']          = $row['from'];
	$row['error']       = 'Site unhealthy after core update; core files restored from backup.';
	$row['rolled_back'] = null === $restore_error;
	if ( get_option( 'db_version' ) !== $db_before ) {
		$row['error'] .= ' Note: the database was already upgraded and was not restored.';
	}
	if ( null !== $restore_error || ! $after['ok'] ) {
		$row['rollback_error']       = null !== $restore_error ? 'Restore failed: ' . $restore_error : 'Site still unhealthy after restoring core files.';
		$row['backup_path']          = nb_mcp_bridge_relative_path( $backup_dir );
		$row['health_after_restore'] = $after;
	} else {
		$wp_filesystem->delete( $backup_dir, true );
	}
	return $row;
}

/**
 * Builds a stable identifier for a translation update offer.
 *
 * @param object $update Language pack update object from wp_get_translation_updates().
 * @return string "<type>:<slug>:<language>", e.g. "plugin:akismet:nl_NL".
 */
function nb_mcp_bridge_translation_key( $update ) {
	return sprintf( '%s:%s:%s', $update->type, $update->slug, $update->language );
}

/**
 * Whether the translation offered by a language pack update is now installed locally.
 *
 * Mirrors how WordPress decides a pack is outdated: the installed file's
 * PO-Revision-Date is compared with the pack's `updated` timestamp.
 *
 * @param object $update Language pack update object from wp_get_translation_updates().
 * @return bool
 */
function nb_mcp_bridge_translation_is_installed( $update ) {
	$offered_at = strtotime( $update->updated );
	if ( false === $offered_at ) {
		return false;
	}

	if ( 'core' === $update->type ) {
		// A core pack ships several files (default, admin, admin-network,
		// continents-cities); its `updated` date follows the newest of them.
		$installed = wp_get_installed_translations( 'core' );
		$domains   = array_keys( $installed );
	} else {
		$installed = wp_get_installed_translations( $update->type . 's' );
		$domains   = array( $update->slug );
	}

	$newest = false;
	foreach ( $domains as $domain ) {
		if ( empty( $installed[ $domain ][ $update->language ]['PO-Revision-Date'] ) ) {
			continue;
		}
		$revised = strtotime( $installed[ $domain ][ $update->language ]['PO-Revision-Date'] );
		if ( false !== $revised && ( false === $newest || $revised > $newest ) ) {
			$newest = $revised;
		}
	}

	return false !== $newest && $newest >= $offered_at;
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
				'success'   => true,
				'count'     => 0,
				'failed'    => 0,
				'no_update' => true,
			)
		);
	}

	$skin     = new WP_Ajax_Upgrader_Skin();
	$upgrader = new Language_Pack_Upgrader( $skin );
	$result   = $upgrader->bulk_upgrade( $updates );

	// The per-item array returned by bulk_upgrade() is not trustworthy: WP_Upgrader
	// keeps $this->result from the previous item, so a failure that follows a success
	// is reported as a success. A network re-check is not trustworthy either (an
	// api.wordpress.org outage would make every pack look "no longer pending").
	// Decide from local files: a pack is installed only when the translation on disk
	// is at least as new as the pack that was offered.
	$still_pending = array();
	foreach ( $updates as $update ) {
		if ( ! nb_mcp_bridge_translation_is_installed( $update ) ) {
			$still_pending[] = nb_mcp_bridge_translation_key( $update );
		}
	}

	// Refresh the update caches so later GET /updates calls reflect reality; the
	// outcome above does not depend on this succeeding.
	foreach ( array( 'update_core', 'update_plugins', 'update_themes' ) as $transient ) {
		delete_site_transient( $transient );
	}
	wp_version_check();
	wp_update_plugins();
	wp_update_themes();

	$failed    = count( $still_pending );
	$succeeded = count( $updates ) - $failed;
	$errors    = array();

	if ( is_wp_error( $result ) ) {
		$errors[] = $result->get_error_message();
	}
	if ( $failed > 0 ) {
		$messages = array_filter( array_map( 'trim', (array) $skin->get_error_messages() ), 'strlen' );
		$errors   = array_merge( $errors, array_values( $messages ) );
		if ( empty( $errors ) ) {
			$errors[] = __( 'Translation update did not complete.', 'nb-mcp-bridge' );
		}
	}

	$response = array(
		'success' => 0 === $failed,
		'count'   => $succeeded,
		'failed'  => $failed,
	);

	if ( $failed > 0 ) {
		$response['failed_items'] = array_values( $still_pending );
	}
	if ( ! empty( $errors ) ) {
		$response['errors'] = array_values( array_unique( $errors ) );
	}

	return rest_ensure_response( $response );
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

/*
 * ---------------------------------------------------------------------------
 * Safe updates (since 1.1.0): backup → update → health check → restore.
 *
 * Everything happens inside the single REST request that performs the update:
 * if an update makes the site fatal, the REST API (and so any later "undo"
 * request) would be broken too, but this request still runs the old code from
 * memory and can put the old files back. Same principle as WordPress' own
 * rollback of failed automatic updates (6.6+).
 * ---------------------------------------------------------------------------
 */

define( 'NB_MCP_BRIDGE_BACKUP_DIRNAME', 'nb-mcp-backups' );
define( 'NB_MCP_BRIDGE_MAX_HEALTH_PATHS', 10 );

/**
 * Validate the optional `health_paths` parameter: site-relative paths only
 * ("/shop"), so the health check can never be pointed at another host.
 *
 * @return true|WP_Error
 */
function nb_mcp_bridge_validate_health_paths( $value, $request, $param ) {
	if ( null === $value ) {
		return true;
	}
	if ( ! is_array( $value ) || count( $value ) > NB_MCP_BRIDGE_MAX_HEALTH_PATHS ) {
		return new WP_Error(
			'nb_mcp_invalid_params',
			sprintf( 'The "%s" parameter must be an array of at most %d paths.', $param, NB_MCP_BRIDGE_MAX_HEALTH_PATHS ),
			array( 'status' => 400 )
		);
	}
	foreach ( $value as $path ) {
		if ( ! nb_mcp_bridge_is_valid_health_path( $path ) ) {
			return new WP_Error(
				'nb_mcp_invalid_params',
				sprintf( 'Invalid health check path in "%s": paths must start with a single "/" and contain no spaces.', $param ),
				array( 'status' => 400 )
			);
		}
	}
	return true;
}

/**
 * @param mixed $path
 * @return bool
 */
function nb_mcp_bridge_is_valid_health_path( $path ) {
	return is_string( $path )
		&& strlen( $path ) <= 200
		&& 1 === preg_match( '#^/(?!/)[^\s\\\\]*$#', $path );
}

/**
 * Absolute path of the directory holding safe-update backups. Prefers a
 * directory outside the web root (backed-up PHP files must never be reachable
 * by URL; nginx hosts such as Kinsta ignore .htaccess), falling back to
 * wp-content with an unguessable run directory name. Override with the
 * NB_MCP_BRIDGE_BACKUP_DIR constant.
 */
function nb_mcp_bridge_backup_root() {
	static $root = null;
	if ( null !== $root ) {
		return $root;
	}
	if ( defined( 'NB_MCP_BRIDGE_BACKUP_DIR' ) && is_string( NB_MCP_BRIDGE_BACKUP_DIR ) && '' !== NB_MCP_BRIDGE_BACKUP_DIR ) {
		$root = untrailingslashit( NB_MCP_BRIDGE_BACKUP_DIR );
		return $root;
	}
	$outside = dirname( untrailingslashit( ABSPATH ) ) . '/' . NB_MCP_BRIDGE_BACKUP_DIRNAME;
	if ( @is_dir( $outside ) ? @is_writable( $outside ) : @is_writable( dirname( $outside ) ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		$root = $outside;
		return $root;
	}
	$root = trailingslashit( WP_CONTENT_DIR ) . NB_MCP_BRIDGE_BACKUP_DIRNAME;
	return $root;
}

/**
 * Creates (once per request) an unguessable run directory for backups, and
 * makes sure the backup root cannot be listed or served.
 *
 * @return string|WP_Error Absolute path of the run directory.
 */
function nb_mcp_bridge_backup_run_dir( $peek = false ) {
	global $wp_filesystem;
	static $run_dir = null;

	if ( null !== $run_dir || $peek ) {
		return $run_dir;
	}

	$root = nb_mcp_bridge_backup_root();
	if ( ! $wp_filesystem->is_dir( $root ) && ! $wp_filesystem->mkdir( $root, FS_CHMOD_DIR ) ) {
		return new WP_Error( 'nb_mcp_backup_failed', 'Could not create the backup directory in wp-content.', array( 'status' => 500 ) );
	}
	$wp_filesystem->put_contents( $root . '/index.php', "<?php\n// Silence is golden.\n", FS_CHMOD_FILE );
	$wp_filesystem->put_contents( $root . '/.htaccess', "Require all denied\nDeny from all\n", FS_CHMOD_FILE );

	// Random name: some hosts (nginx, e.g. Kinsta) ignore .htaccess.
	$candidate = $root . '/' . gmdate( 'Ymd-His' ) . '-' . strtolower( wp_generate_password( 20, false ) );
	if ( ! $wp_filesystem->mkdir( $candidate, FS_CHMOD_DIR ) ) {
		return new WP_Error( 'nb_mcp_backup_failed', 'Could not create the backup run directory.', array( 'status' => 500 ) );
	}
	$run_dir = $candidate;
	// Safety net for backups kept after a failed restore (or an aborted request).
	if ( ! wp_next_scheduled( 'nb_mcp_bridge_cleanup_backups' ) ) {
		wp_schedule_event( time() + DAY_IN_SECONDS, 'daily', 'nb_mcp_bridge_cleanup_backups' );
	}
	return $run_dir;
}

/**
 * Path relative to ABSPATH, for messages (never exposes more than the site layout).
 */
function nb_mcp_bridge_relative_path( $path ) {
	$abs = wp_normalize_path( dirname( untrailingslashit( ABSPATH ) ) );
	$p   = wp_normalize_path( $path );
	return 0 === strpos( $p, $abs ) ? ltrim( substr( $p, strlen( $abs ) ), '/' ) : basename( $p );
}

/**
 * Copies a file or directory to $dest (created as needed).
 *
 * @return true|WP_Error
 */
function nb_mcp_bridge_copy_path( $source, $dest ) {
	global $wp_filesystem;

	if ( $wp_filesystem->is_file( $source ) ) {
		$wp_filesystem->mkdir( dirname( $dest ), FS_CHMOD_DIR );
		return $wp_filesystem->copy( $source, $dest, true, FS_CHMOD_FILE )
			? true
			: new WP_Error( 'nb_mcp_copy_failed', 'Could not copy ' . nb_mcp_bridge_relative_path( $source ) );
	}

	if ( ! $wp_filesystem->is_dir( $dest ) && ! wp_mkdir_p( $dest ) ) {
		return new WP_Error( 'nb_mcp_copy_failed', 'Could not create ' . nb_mcp_bridge_relative_path( $dest ) );
	}
	$result = copy_dir( $source, $dest );
	return is_wp_error( $result ) ? $result : true;
}

/**
 * Deletes entries under $target that do not exist under $reference
 * (files an update added), recursively.
 */
function nb_mcp_bridge_remove_extra_entries( $target, $reference ) {
	global $wp_filesystem;

	$list = $wp_filesystem->dirlist( $target, true, false );
	if ( ! is_array( $list ) ) {
		return;
	}
	foreach ( $list as $name => $entry ) {
		$t = trailingslashit( $target ) . $name;
		$r = trailingslashit( $reference ) . $name;
		if ( ! $wp_filesystem->exists( $r ) ) {
			$wp_filesystem->delete( $t, true );
		} elseif ( 'd' === $entry['type'] ) {
			nb_mcp_bridge_remove_extra_entries( $t, $r );
		}
	}
}

/**
 * Restores $target from $backup without ever leaving $target empty: first
 * overwrite with the backed-up files, then drop files the update added.
 *
 * @return true|WP_Error
 */
function nb_mcp_bridge_restore_path( $backup, $target ) {
	global $wp_filesystem;

	if ( $wp_filesystem->is_file( $backup ) ) {
		return nb_mcp_bridge_copy_path( $backup, $target );
	}
	if ( $wp_filesystem->exists( $target ) && ! $wp_filesystem->is_dir( $target ) ) {
		$wp_filesystem->delete( $target );
	}
	$copied = nb_mcp_bridge_copy_path( $backup, $target );
	if ( is_wp_error( $copied ) ) {
		return $copied;
	}
	nb_mcp_bridge_remove_extra_entries( $target, $backup );
	return true;
}

/**
 * Where a plugin/theme lives on disk.
 *
 * @param string $type 'plugin' or 'theme'.
 * @return string Absolute path (directory, or file for single-file plugins).
 */
function nb_mcp_bridge_item_path( $type, $id ) {
	if ( 'plugin' === $type ) {
		$dir = dirname( $id );
		return '.' === $dir ? WP_PLUGIN_DIR . '/' . $id : WP_PLUGIN_DIR . '/' . $dir;
	}
	return trailingslashit( get_theme_root( $id ) ) . $id;
}

/**
 * Like nb_mcp_bridge_item_path(), but only for items WordPress actually knows
 * and whose resolved path lies strictly inside the plugins/theme root. Request
 * input never reaches a filesystem operation without passing this.
 *
 * @return string|null
 */
function nb_mcp_bridge_safe_item_path( $type, $id ) {
	if ( ! is_string( $id ) || '' === $id || false !== strpos( $id, '..' ) || false !== strpos( $id, '\\' ) ) {
		return null;
	}
	if ( 'plugin' === $type ) {
		$plugins = get_plugins();
		if ( ! isset( $plugins[ $id ] ) || substr_count( $id, '/' ) > 1 ) {
			return null;
		}
		$root = WP_PLUGIN_DIR;
	} else {
		if ( false !== strpos( $id, '/' ) || ! wp_get_theme( $id )->exists() ) {
			return null;
		}
		$root = get_theme_root( $id );
	}
	$path      = nb_mcp_bridge_item_path( $type, $id );
	$real      = realpath( $path );
	$real_root = realpath( $root );
	if ( false === $real || false === $real_root || 0 !== strpos( wp_normalize_path( $real ), trailingslashit( wp_normalize_path( $real_root ) ) ) ) {
		return null;
	}
	$name = basename( $path );
	return ( '' === $name || '.' === $name || '..' === $name ) ? null : $path;
}

/**
 * Files that make up WordPress core, relative to ABSPATH (wp-config.php and
 * wp-content are never touched).
 *
 * @return string[]
 */
function nb_mcp_bridge_core_entries() {
	$entries = array( 'wp-admin', 'wp-includes' );
	foreach ( (array) glob( ABSPATH . '*.php' ) as $file ) {
		$name = basename( $file );
		if ( 'wp-config.php' !== $name ) {
			$entries[] = $name;
		}
	}
	return $entries;
}

/**
 * Error log to scan for new fatal errors, if one is readable.
 *
 * @return string|null
 */
function nb_mcp_bridge_error_log_path() {
	$debug_log  = null;
	$candidates = array();
	if ( defined( 'WP_DEBUG_LOG' ) && is_string( WP_DEBUG_LOG ) && '' !== WP_DEBUG_LOG ) {
		$debug_log = WP_DEBUG_LOG;
	} elseif ( defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG ) {
		$debug_log = WP_CONTENT_DIR . '/debug.log';
	}
	if ( $debug_log ) {
		$candidates[] = $debug_log;
	}
	$ini = ini_get( 'error_log' );
	if ( is_string( $ini ) && '' !== $ini && 'syslog' !== $ini ) {
		$candidates[] = $ini;
	}
	foreach ( $candidates as $path ) {
		if ( @is_file( $path ) && @is_readable( $path ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			return $path;
		}
	}
	// WP creates debug.log on the first error, possibly during the update itself.
	return ( $debug_log && @is_writable( dirname( $debug_log ) ) ) ? $debug_log : null; // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
}

/**
 * Current end of the error log, so only lines written after it are scanned.
 *
 * @return array{path: string|null, offset: int}
 */
function nb_mcp_bridge_error_log_mark() {
	$path = nb_mcp_bridge_error_log_path();
	clearstatcache();
	return array(
		'path'   => $path,
		'offset' => ( $path && @is_file( $path ) ) ? (int) @filesize( $path ) : 0, // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	);
}

/**
 * First new fatal/parse error in the error log since $mark, if any.
 *
 * @return array{ok: bool, available: bool, error?: string}
 */
function nb_mcp_bridge_scan_error_log( $mark ) {
	if ( empty( $mark['path'] ) ) {
		return array( 'ok' => true, 'available' => false );
	}
	clearstatcache();
	$size = @is_file( $mark['path'] ) ? (int) @filesize( $mark['path'] ) : 0; // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	if ( $size <= $mark['offset'] ) {
		return array( 'ok' => true, 'available' => true );
	}
	$handle = @fopen( $mark['path'], 'rb' ); // phpcs:ignore
	if ( ! $handle ) {
		return array( 'ok' => true, 'available' => false );
	}
	fseek( $handle, $mark['offset'] );
	$chunk = (string) fread( $handle, min( $size - $mark['offset'], 262144 ) ); // phpcs:ignore
	fclose( $handle ); // phpcs:ignore
	if ( preg_match( '/^.*PHP (?:Fatal|Parse) error.*$/m', $chunk, $m ) ) {
		return array( 'ok' => false, 'available' => true, 'error' => substr( trim( $m[0] ), 0, 300 ) );
	}
	return array( 'ok' => true, 'available' => true );
}

/**
 * Fetches one URL of this site (loopback) and decides whether it is healthy.
 *
 * @param bool $strict When true, HTTP 4xx also counts as a failure (extra paths).
 * @return array{ok: bool, status?: int, error?: string}
 */
function nb_mcp_bridge_probe( $url, $strict ) {
	// Unique query arg so page/edge caches (Kinsta, Cloudflare) cannot answer.
	$url      = add_query_arg( 'nb_mcp_health', strtolower( wp_generate_password( 12, false ) ), $url );
	$response = wp_remote_get(
		$url,
		array(
			'timeout'     => 30,
			'redirection' => 5,
			'sslverify'   => apply_filters( 'https_local_ssl_verify', false ),
			'headers'     => array(
				'Cache-Control' => 'no-cache',
				'Pragma'        => 'no-cache',
			),
		)
	);
	if ( is_wp_error( $response ) ) {
		return array( 'ok' => false, 'error' => $response->get_error_message() );
	}
	$status = (int) wp_remote_retrieve_response_code( $response );
	$body   = (string) wp_remote_retrieve_body( $response );

	$markers = array(
		__( 'There has been a critical error on this website.' ), // phpcs:ignore WordPress.WP.I18n.MissingArgDomain -- core string, translated by core.
		'There has been a critical error on this website',
		'<b>Fatal error</b>:',
		'<b>Parse error</b>:',
		'PHP Fatal error',
	);
	foreach ( $markers as $marker ) {
		if ( '' !== $marker && false !== strpos( $body, $marker ) ) {
			return array( 'ok' => false, 'status' => $status, 'error' => 'Page shows a PHP fatal error.' );
		}
	}
	if ( $status >= 500 || ( $strict && $status >= 400 ) || 0 === $status ) {
		return array( 'ok' => false, 'status' => $status, 'error' => 'HTTP ' . $status );
	}
	return array( 'ok' => true, 'status' => $status );
}

/**
 * Runs all health checks: homepage, login page, extra paths and (after an
 * update) the error log. Checks that already failed in $baseline are reported
 * but do not count, so a pre-existing 404 never triggers a rollback.
 *
 * @param string[]   $paths    Extra site-relative paths.
 * @param array|null $baseline Result of the pre-update check, or null for the baseline itself.
 * @param array|null $log_mark From nb_mcp_bridge_error_log_mark(), taken before the update.
 * @return array{ok: bool, checks: array<int, array>}
 */
function nb_mcp_bridge_health_check( $paths, $baseline = null, $log_mark = null ) {
	$targets = array(
		array( 'target' => 'home', 'url' => home_url( '/' ), 'strict' => false ),
		array( 'target' => 'login', 'url' => wp_login_url(), 'strict' => false ),
	);
	foreach ( (array) $paths as $path ) {
		$targets[] = array( 'target' => $path, 'url' => home_url( $path ), 'strict' => true );
	}

	$failed_before = array();
	if ( $baseline ) {
		foreach ( $baseline['checks'] as $check ) {
			if ( ! $check['ok'] ) {
				$failed_before[ $check['target'] ] = true;
			}
		}
	}

	$checks = array();
	$ok     = true;
	foreach ( $targets as $t ) {
		$result = array_merge( array( 'target' => $t['target'] ), nb_mcp_bridge_probe( $t['url'], $t['strict'] ) );
		if ( ! $result['ok'] && isset( $failed_before[ $t['target'] ] ) ) {
			$result['ignored'] = true; // Already failing before the update.
		} elseif ( ! $result['ok'] ) {
			$ok = false;
		}
		$checks[] = $result;
	}

	if ( $log_mark ) {
		$log      = nb_mcp_bridge_scan_error_log( $log_mark );
		$checks[] = array_merge( array( 'target' => 'error_log' ), $log );
		if ( ! $log['ok'] ) {
			$ok = false;
		}
	}

	return array( 'ok' => $ok, 'checks' => $checks );
}

/**
 * Pre-update health check. The homepage must work before we update anything,
 * otherwise the post-update check cannot tell what the update broke.
 *
 * @return array|WP_Error Baseline check result.
 */
function nb_mcp_bridge_safe_baseline( $paths ) {
	$baseline = nb_mcp_bridge_health_check( $paths );
	foreach ( $baseline['checks'] as $check ) {
		if ( 'home' === $check['target'] && ! $check['ok'] ) {
			return new WP_Error(
				'nb_mcp_site_unhealthy',
				'The homepage already fails before updating (' . ( isset( $check['error'] ) ? $check['error'] : 'unknown' ) . '); no updates were run.',
				array( 'status' => 409, 'health' => $baseline )
			);
		}
	}
	return $baseline;
}

/**
 * Safe update of one plugin or theme: backup → update → check → restore.
 *
 * @param string   $type     'plugin' or 'theme'.
 * @param string   $id       Plugin file or theme stylesheet.
 * @param array    $baseline Pre-update health check.
 * @param string[] $paths    Extra health check paths.
 * @param callable $run      Runs the regular upgrade for [$id] and returns its result row.
 * @param callable $after_restore Called after files are restored (reactivation, caches).
 * @return array Result row (regular fields + backup/health/rolled_back).
 */
function nb_mcp_bridge_safe_update_item( $type, $id, $baseline, $paths, $run, $after_restore ) {
	global $wp_filesystem;

	$source = nb_mcp_bridge_safe_item_path( $type, $id );
	if ( null === $source ) {
		// Unknown or invalid item: let the regular runner report it; never back up or restore.
		return array_merge( call_user_func( $run ), array( 'backup' => 'none', 'rolled_back' => false ) );
	}

	$run_dir = nb_mcp_bridge_backup_run_dir();
	if ( is_wp_error( $run_dir ) ) {
		return array( $type => $id, 'success' => false, 'from' => '', 'to' => '', 'error' => 'Backup failed: ' . $run_dir->get_error_message(), 'backup' => 'failed', 'rolled_back' => false );
	}
	$backup = $run_dir . '/' . $type . 's/' . basename( $source );
	$copied = nb_mcp_bridge_copy_path( $source, $backup );
	if ( is_wp_error( $copied ) ) {
		$wp_filesystem->delete( $backup, true );
		return array( $type => $id, 'success' => false, 'from' => '', 'to' => '', 'error' => 'Backup failed, update not run: ' . $copied->get_error_message(), 'backup' => 'failed', 'rolled_back' => false );
	}

	$log_mark = nb_mcp_bridge_error_log_mark();
	$row      = call_user_func( $run );

	if ( ! empty( $row['no_update'] ) ) {
		$wp_filesystem->delete( $backup, true );
		return array_merge( $row, array( 'backup' => 'none', 'rolled_back' => false ) );
	}

	// A failed upgrade may have removed the old copy already (clear_destination).
	$missing = ! $wp_filesystem->exists( $source );
	$health  = $missing ? array( 'ok' => false, 'checks' => array() ) : nb_mcp_bridge_health_check( $paths, $baseline, $log_mark );

	if ( $health['ok'] ) {
		$wp_filesystem->delete( $backup, true );
		return array_merge( $row, array( 'backup' => 'created', 'health' => $health, 'rolled_back' => false ) );
	}

	$restored = nb_mcp_bridge_restore_path( $backup, $source );
	call_user_func( $after_restore );
	$after = nb_mcp_bridge_health_check( $paths, $baseline );

	$result = array_merge(
		$row,
		array(
			'success'     => false,
			'to'          => $row['from'],
			'error'       => $missing ? 'Update failed and removed the old files; restored from backup.' : 'Site unhealthy after update; restored from backup.',
			'backup'      => 'created',
			'health'      => $health,
			'rolled_back' => ! is_wp_error( $restored ),
		)
	);
	if ( is_wp_error( $restored ) || ! $after['ok'] ) {
		$result['rollback_error'] = is_wp_error( $restored )
			? 'Restore failed: ' . $restored->get_error_message()
			: 'Site still unhealthy after restoring the backup.';
		$result['backup_path']    = nb_mcp_bridge_relative_path( $backup );
		$result['health_after_restore'] = $after;
	} else {
		$wp_filesystem->delete( $backup, true );
	}
	return $result;
}

/**
 * True when $dir contains at least one file, at any depth.
 */
function nb_mcp_bridge_dir_has_files( $dir ) {
	global $wp_filesystem;
	foreach ( (array) $wp_filesystem->dirlist( $dir, true, false ) as $name => $entry ) {
		if ( 'f' === $entry['type'] || nb_mcp_bridge_dir_has_files( trailingslashit( $dir ) . $name ) ) {
			return true;
		}
	}
	return false;
}

/**
 * Removes this request's run directory when no backups were kept.
 */
function nb_mcp_bridge_finish_backup_run() {
	global $wp_filesystem;
	$run_dir = nb_mcp_bridge_backup_run_dir( true );
	if ( $run_dir && $wp_filesystem->is_dir( $run_dir ) && ! nb_mcp_bridge_dir_has_files( $run_dir ) ) {
		$wp_filesystem->delete( $run_dir, true );
	}
}

/**
 * Daily clean-up of backups older than a day (e.g. kept after a failed restore).
 */
function nb_mcp_bridge_cleanup_old_backups() {
	$root = nb_mcp_bridge_backup_root();
	if ( ! is_dir( $root ) ) {
		return;
	}
	require_once ABSPATH . 'wp-admin/includes/file.php';
	if ( ! WP_Filesystem() ) {
		return;
	}
	global $wp_filesystem;
	foreach ( (array) glob( $root . '/*', GLOB_ONLYDIR ) as $dir ) {
		if ( filemtime( $dir ) < time() - DAY_IN_SECONDS ) {
			$wp_filesystem->delete( $dir, true );
		}
	}
}
add_action( 'nb_mcp_bridge_cleanup_backups', 'nb_mcp_bridge_cleanup_old_backups' );

