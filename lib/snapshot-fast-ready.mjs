export function snapshotFastReadyStatus({ enabled, markerExists }) {
  if (!enabled) {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (!markerExists) {
    return { status: 503, body: { ready: false } };
  }
  return { status: 200, body: { ready: true } };
}
