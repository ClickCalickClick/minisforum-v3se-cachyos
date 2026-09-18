import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

/**
 * Errors surfaced by the provider clients. Optional providers translate any of
 * these into a degraded (null) result at the pipeline seam; only the required
 * forecast call propagates them.
 */
export class HttpError extends Error {
    constructor(kind, detail = null, status = 0) {
        super(`${kind}${status ? ` ${status}` : ''}${detail ? `: ${detail}` : ''}`);
        this.name = 'HttpError';
        this.kind = kind;        // 'badURL' | 'transport' | 'status' | 'decoding' | 'emptyBody'
        this.status = status;
    }
}

const decoder = new TextDecoder();

/** Build a URL from a base and a query object (values are stringified). */
export function buildURL(base, params) {
    const q = Object.entries(params)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return q ? `${base}?${q}` : base;
}

/**
 * Thin wrapper over a Soup 3 session: GET-and-decode-JSON, GET bytes, and a
 * status-only POST. One session per timeout class (15 s JSON, 6 s alerts,
 * 25 s imagery) mirrors the Mac's per-purpose `URLSession`s.
 */
export class HttpClient {
    constructor({timeout = 15, userAgent = 'TouchyWeatherGNOME/dev (jwuerz@gmail.com)', session = null} = {}) {
        this.session = session ?? new Soup.Session({timeout, user_agent: userAgent});
    }

    /** Abort every in-flight request (extension disable). */
    abort() {
        this.session.abort();
    }

    _send(msg, cancellable) {
        return new Promise((resolve, reject) => {
            this.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    reject(new HttpError('transport', e.message));
                    return;
                }
                const status = msg.get_status();
                if (status < 200 || status > 299) {
                    reject(new HttpError('status', msg.get_reason_phrase(), status));
                    return;
                }
                resolve(bytes);
            });
        });
    }

    /** GET raw bytes (Uint8Array), or throw HttpError. */
    async getBytes(url, headers = {}, cancellable = null) {
        const msg = Soup.Message.new('GET', url);
        if (!msg) throw new HttpError('badURL', url);
        for (const [k, v] of Object.entries(headers)) msg.request_headers.append(k, v);
        const bytes = await this._send(msg, cancellable);
        const data = bytes.get_data();
        if (!data || data.length === 0) throw new HttpError('emptyBody');
        return data;
    }

    /** GET and JSON-decode. */
    async getJSON(url, headers = {}, cancellable = null) {
        const data = await this.getBytes(url, headers, cancellable);
        try {
            return JSON.parse(decoder.decode(data));
        } catch (e) {
            throw new HttpError('decoding', e.message);
        }
    }

    /** POST a JSON body and validate the status only. */
    async postJSON(url, body, headers = {}, cancellable = null) {
        const msg = Soup.Message.new('POST', url);
        if (!msg) throw new HttpError('badURL', url);
        for (const [k, v] of Object.entries(headers)) msg.request_headers.append(k, v);
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bytes));
        await this._send(msg, cancellable);
    }
}
