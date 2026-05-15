const BASE_URL = ''

/**
 * Low-level fetch wrapper with error handling.
 * - Automatically stringifies JSON bodies
 * - Sets Content-Type: application/json
 * - Throws on non-2xx responses with server error message when available
 * - Returns parsed JSON (or null for 204 No Content)
 */
export async function request(path, options = {}) {
  const { body, headers: customHeaders, rawBody, ...rest } = options

  const headers = { ...(rawBody ? {} : { 'Content-Type': 'application/json' }), ...customHeaders }
  const config = { ...rest, headers }

  if (body && !rawBody) {
    config.body = JSON.stringify(body)
  } else if (rawBody) {
    config.body = rawBody
  }

  const res = await fetch(`${BASE_URL}${path}`, config)

  if (!res.ok) {
    let message = `Request failed: ${res.status}`
    try {
      const err = await res.json()
      message = err.error || err.message || message
    } catch { /* non-JSON error body */ }
    const error = new Error(message)
    error.status = res.status
    throw error
  }

  if (res.status === 204) return null

  // For endpoints that return plain text (e.g. install script, metrics)
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/') && !contentType.includes('json')) {
    return res.text()
  }

  return res.json()
}

/**
 * Convenience helpers
 */
export function get(path) {
  return request(path, { method: 'GET' })
}

export function post(path, body) {
  return request(path, { method: 'POST', body })
}

export function put(path, body) {
  return request(path, { method: 'PUT', body })
}

export function del(path) {
  return request(path, { method: 'DELETE' })
}