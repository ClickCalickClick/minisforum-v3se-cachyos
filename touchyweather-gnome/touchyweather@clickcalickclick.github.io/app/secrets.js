import GLib from 'gi://GLib';

/**
 * Resolves the Vercel proxy key (Secrets.swift). First non-empty wins:
 *   1. TW_PROXY_KEY environment variable,
 *   2. the `proxy-key` GSetting (Preferences → General),
 *   3. ~/.config/touchyweather/secrets.json  { "PROXY_KEY": "…" }.
 * Absent ⇒ "" and proxy features (non-Europe pollen, analytics) degrade silently.
 */
export function resolveProxyKey(prefs) {
    const env = GLib.getenv('TW_PROXY_KEY');
    if (env) return env;
    const setting = prefs.proxyKey;
    if (setting) return setting;
    const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'touchyweather', 'secrets.json']);
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (ok) {
            const key = JSON.parse(new TextDecoder().decode(bytes)).PROXY_KEY;
            if (typeof key === 'string' && key) return key;
        }
    } catch (_e) {
        // no secrets file — fine
    }
    return '';
}
