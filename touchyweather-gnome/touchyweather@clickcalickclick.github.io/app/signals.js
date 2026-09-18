/** A minimal observable: `connect(cb)` → id, `disconnect(id)`, `emit(...args)`. */
export class Emitter {
    constructor() {
        this._next = 1;
        this._handlers = new Map();
    }

    connect(cb) {
        const id = this._next++;
        this._handlers.set(id, cb);
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(...args) {
        for (const cb of [...this._handlers.values()]) {
            try {
                cb(...args);
            } catch (e) {
                console.error(`TouchyWeather: handler failed: ${e.message}\n${e.stack}`);
            }
        }
    }

    clear() {
        this._handlers.clear();
    }
}
