'use strict';
const { UserError } = require('../util/format');

/**
 * The mint configuration itself is invalid or does not match the schedule
 * (wrong recipient, unsupported function, bad proof format...). Safe to show to
 * the user, and never fixed by retrying.
 */
class MintSpecError extends UserError {
  constructor(message) { super(message); this.name = 'MintSpecError'; }
}

/**
 * An operator-configured eligibility provider failed. `userMessage` never
 * contains the provider's URL, headers or response body.
 * Retryable only for 429, 5xx, timeouts and network failures; a 4xx means the
 * provider refused this wallet/request.
 */
class ProviderError extends Error {
  constructor(userMessage, { status = null, retryable = false } = {}) {
    super(userMessage);
    this.name = 'ProviderError';
    this.userMessage = userMessage;
    this.status = status;
    this.retryable = retryable;
  }
}

module.exports = { MintSpecError, ProviderError };
