export type YandexErrorCode = 'INVALID_ARGUMENT' | 'READ_ONLY' | 'AUTH_REQUIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'OUTCOME_UNKNOWN' | 'NETWORK_ERROR';

export class YandexApiError extends Error {
  readonly code: YandexErrorCode;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly outcomeUnknown: boolean;
  constructor(code: YandexErrorCode, options: { httpStatus?: number; requestId?: string } = {}) {
    super(code === 'OUTCOME_UNKNOWN' ? 'The command outcome is unknown; do not automatically repeat it.' : `Yandex API request failed: ${code}.`);
    this.name = 'YandexApiError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.requestId = options.requestId;
    this.outcomeUnknown = code === 'OUTCOME_UNKNOWN';
  }
}
