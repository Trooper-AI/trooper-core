/**
 * Keep routine reads constrained to models already configured for this gateway.
 * An explicit picker refresh discovers current provider models dynamically.
 */
export function modelListParamsForRefresh(refresh = false) {
  return refresh
    ? { view: 'all', refresh: true }
    : { view: 'configured' };
}
