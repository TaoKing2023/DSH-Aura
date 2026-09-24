/**
 * Register the DSH module-resolution hook.
 *
 * Loaded by `node --import` before the test files run; it must do nothing else.
 *
 * @module dsh-aura/tests/helpers/register-resolver
 */

import { register } from 'node:module'

register('./resolver-hook.mjs', import.meta.url)
