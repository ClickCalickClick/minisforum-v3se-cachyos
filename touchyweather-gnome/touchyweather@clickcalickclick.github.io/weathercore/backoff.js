/**
 * Exponential backoff on repeated fetch failure: `5 * 2^(n-1)` minutes for the
 * nth consecutive failure, capped at 240 (comm.c `s_max_backoff_mins`).
 */
export class Backoff {
    static baseMinutes = 5;
    static capMinutes = 240;

    constructor(consecutiveFailures = 0, lastFailureAt = null) {
        this.consecutiveFailures = consecutiveFailures;
        this.lastFailureAt = lastFailureAt;    // unix seconds or null
    }

    /** Delay after `n` consecutive failures, in seconds. n<=0 ⇒ 0. */
    static delay(n) {
        if (n <= 0) return 0;
        const minutes = n - 1 >= 31
            ? Backoff.capMinutes
            : Math.min(Backoff.capMinutes, Backoff.baseMinutes * 2 ** (n - 1));
        return minutes * 60;
    }

    recordSuccess() {
        this.consecutiveFailures = 0;
        this.lastFailureAt = null;
    }

    recordFailure(at = Date.now() / 1000) {
        this.consecutiveFailures += 1;
        this.lastFailureAt = at;
    }

    get currentDelay() {
        return Backoff.delay(this.consecutiveFailures);
    }

    mayRetry(now = Date.now() / 1000) {
        if (this.lastFailureAt === null || this.consecutiveFailures === 0) return true;
        return now - this.lastFailureAt >= this.currentDelay;
    }
}
