export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export class CliClient {
  constructor({ server, cookie = '', timeoutMs = Number(process.env.TEAM_LOOP_CLI_TIMEOUT_MS || 300000), fetchImpl = fetch, clientType = 'cli' }) {
    this.server = server;
    this.cookie = cookie;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clientType = ['cli', 'collector'].includes(clientType) ? clientType : 'cli';
  }

  async request(path, { method = 'GET', body, authenticated = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { Accept: 'application/json', 'X-Team-Loop-Client': this.clientType };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authenticated && this.cookie) headers.Cookie = this.cookie;
      const response = await this.fetchImpl(`${this.server}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let value = {};
      if (text) {
        try { value = JSON.parse(text); } catch { value = { raw: text }; }
      }
      if (!response.ok) throw new ApiError(response.status, value.error || `HTTP ${response.status}`, value.details);
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';', 1)[0];
      return value;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Request timed out after ${this.timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
