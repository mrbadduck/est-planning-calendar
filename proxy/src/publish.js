// Pure helpers for the Eventbrite publish flow. No I/O — unit-tested.

// Map Coda's GET /mutationStatus/:id response to our route's response.
export function mutationResult(status, body) {
  if (status === 200) return { httpStatus: 200, json: { completed: !!(body && body.completed) } };
  if (status === 400) return { httpStatus: 400, json: { error: 'unknown request id' } };
  return { httpStatus: 502, json: { error: `coda ${status}` } };
}
