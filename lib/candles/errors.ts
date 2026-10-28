/**
 * errors.ts - what can go wrong when asking a market-data provider for candles.
 * The route turns each code into an HTTP status + a message the UI can explain.
 */
export type ProviderErrorCode =
  | 'not_configured' // no API key set on the server
  | 'auth' //           the provider rejected the key
  | 'plan' //           the key is valid but its plan does not include this data
  | 'rate_limited' //   too many requests for the plan
  | 'blocked' //        the provider refuses automated requests (e.g. Dukascopy's bot challenge)
  | 'upstream'; //      anything else (outage, unexpected response)

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
