import { createHash } from 'node:crypto';
import { FAVICON_SVG } from './icons.js';
import { APP_JS } from './scripts.js';
import { APP_CSS } from './styles.js';

export { APP_CSS, APP_JS, FAVICON_SVG };

/**
 * Content hash appended to asset URLs, so a deploy never serves a cached old stylesheet
 * while the assets themselves can be cached for a year.
 */
export const ASSET_VERSION = createHash('sha256').update(APP_CSS).update(APP_JS).update(FAVICON_SVG).digest('hex').slice(0, 12);
