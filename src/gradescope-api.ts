import { parse as parseHTML } from "node-html-parser";
import { parseAssignmentPdfLink } from "./student-pdf.js";
import type { GradescopeProvidedPdf } from "./types.js";

const maxProvidedPdfBytes = 25 * 1024 * 1024;

export class GradescopeAPI {
  private readonly baseUrl = "https://www.gradescope.com";
  private readonly baseOrigin = new URL(this.baseUrl).origin;
  private readonly email: string;
  private readonly password: string;
  private readonly cookies: Map<string, string> = new Map();
  private csrfToken: string | null = null;
  private authenticated = false;
  private lastRequestTime = 0;
  private readonly minRequestInterval: number;
  private readonly maxRedirects = 5;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(email: string, password: string, minRequestInterval = 1000) {
    this.email = email;
    this.password = password;
    this.minRequestInterval = minRequestInterval;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.minRequestInterval - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private extractSetCookies(response: Response): void {
    const nativeHeaders = response.headers.getSetCookie?.() ?? [];
    const combined = response.headers.get("set-cookie");
    const setCookieHeaders = nativeHeaders.length > 0
      ? nativeHeaders
      : combined
        ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
        : [];
    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) this.cookies.set(match[1], match[2]);
    }
  }

  private getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  private resolveUrl(urlPath: string): string {
    const url = new URL(urlPath, `${this.baseUrl}/`);
    if (url.origin !== this.baseOrigin) {
      throw new Error("Gradescope requests must remain on the same origin");
    }
    return url.toString();
  }

  private extractCSRFToken(html: string): string | null {
    const root = parseHTML(html);
    const meta = root.querySelector('meta[name="csrf-token"]');
    if (meta) return meta.getAttribute("content") ?? null;

    const input = root.querySelector('input[name="authenticity_token"]');
    return input?.getAttribute("value") ?? null;
  }

  private isLoginPage(html: string): boolean {
    const root = parseHTML(html);
    return Boolean(
      root.querySelector(
        'form[action="/login"], form[action$="/login"], input[name="session[email]"], input[name="session[password]"]'
      )
    );
  }

  private isRedirect(response: Response): boolean {
    return response.status >= 300 && response.status < 400;
  }

  private isLoginRedirect(response: Response): boolean {
    if (!this.isRedirect(response)) return false;
    return (response.headers.get("location") ?? "").includes("/login");
  }

  private async login(): Promise<void> {
    const loginPageResponse = await fetch(this.resolveUrl("/login"), {
      redirect: "manual",
      headers: {
        "User-Agent": "GradescopeMCP/1.0",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    this.extractSetCookies(loginPageResponse);
    if (!loginPageResponse.ok) {
      throw new Error(`Gradescope login page failed (${loginPageResponse.status})`);
    }
    const loginHtml = await loginPageResponse.text();
    this.csrfToken = this.extractCSRFToken(loginHtml);

    if (!this.csrfToken) {
      throw new Error("Failed to extract CSRF token from Gradescope login page");
    }

    const formBody = new URLSearchParams({
      utf8: "✓",
      authenticity_token: this.csrfToken,
      "session[email]": this.email,
      "session[password]": this.password,
      "session[remember_me]": "1",
      commit: "Log In",
      "session[remember_me_sso]": "0",
    });

    const loginResponse = await fetch(this.resolveUrl("/login"), {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent": "GradescopeMCP/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.getCookieHeader(),
        Referer: this.resolveUrl("/login"),
        Origin: this.baseOrigin,
      },
      body: formBody.toString(),
    });

    this.extractSetCookies(loginResponse);

    if (this.isRedirect(loginResponse)) {
      const location = loginResponse.headers.get("location");
      if (!location) {
        throw new Error("Gradescope login succeeded without a redirect location");
      }
      if (location.includes("/login") || location.includes("/sessions")) {
        throw new Error("Gradescope login failed: invalid email or password");
      }

      const dashboardResponse = await fetch(this.resolveUrl(location), {
        redirect: "manual",
        headers: {
          "User-Agent": "GradescopeMCP/1.0",
          Cookie: this.getCookieHeader(),
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      this.extractSetCookies(dashboardResponse);
      if (!dashboardResponse.ok) {
        throw new Error(`Gradescope dashboard failed (${dashboardResponse.status})`);
      }
      const dashboardHtml = await dashboardResponse.text();
      if (this.isLoginPage(dashboardHtml)) {
        throw new Error("Gradescope authentication returned the login page");
      }
      const newToken = this.extractCSRFToken(dashboardHtml);
      if (newToken) this.csrfToken = newToken;
      this.authenticated = true;
      return;
    }

    if (loginResponse.status === 200) {
      const body = await loginResponse.text();
      if (
        this.isLoginPage(body) ||
        body.includes("Invalid email/password") ||
        body.includes("invalid") ||
        body.includes("error")
      ) {
        throw new Error("Gradescope login failed: invalid email or password");
      }
      this.authenticated = true;
      return;
    }

    throw new Error(`Gradescope login failed with status ${loginResponse.status}`);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authenticated) await this.login();
  }

  async fetchPage(urlPath: string): Promise<string> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    try {
      return await this.fetchPageWithRedirects(urlPath, 0);
    } finally {
      release();
    }
  }

  async fetchAssignmentPdf(
    courseId: string,
    assignmentId: string
  ): Promise<GradescopeProvidedPdf | null> {
    if (!/^\d+$/.test(courseId) || !/^\d+$/.test(assignmentId)) {
      throw new Error("Course and assignment IDs must be numeric");
    }

    const html = await this.fetchPage(`/courses/${courseId}`);
    const link = parseAssignmentPdfLink(html, courseId, assignmentId);
    if (!link) return null;

    // Gradescope stores the provided PDF behind a short-lived, signed S3 URL.
    // Fetch it immediately, without sending the Gradescope cookie jar to the
    // external upload host. The parser only accepts the known Gradescope PDF
    // upload shape, so this method never becomes an arbitrary URL fetcher.
    const response = await fetch(link.url, {
      redirect: "manual",
      headers: { Accept: "application/pdf" },
    });

    if (this.isRedirect(response)) {
      throw new Error("Gradescope provided PDF returned an unexpected redirect");
    }
    if (!response.ok) {
      throw new Error(`Gradescope provided PDF failed (${response.status})`);
    }

    const contentLength = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10
    );
    if (Number.isFinite(contentLength) && contentLength > maxProvidedPdfBytes) {
      throw new Error("Gradescope provided PDF exceeds the 25 MiB safety limit");
    }

    const bytes = await this.readPdfBytes(response);
    const signature = new TextDecoder().decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") {
      throw new Error("Gradescope provided file was not a PDF");
    }

    return {
      filename: link.filename,
      mimeType: "application/pdf",
      bytes,
    };
  }

  private async readPdfBytes(response: Response): Promise<Uint8Array> {
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxProvidedPdfBytes) {
        throw new Error("Gradescope provided PDF exceeds the 25 MiB safety limit");
      }
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxProvidedPdfBytes) {
          await reader.cancel();
          throw new Error("Gradescope provided PDF exceeds the 25 MiB safety limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async fetchPageWithRedirects(
    urlPath: string,
    redirectDepth: number
  ): Promise<string> {
    if (redirectDepth > this.maxRedirects) {
      throw new Error("Gradescope returned too many redirects");
    }

    await this.ensureAuthenticated();
    await this.throttle();

    const url = this.resolveUrl(urlPath);
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "GradescopeMCP/1.0",
        Cookie: this.getCookieHeader(),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    this.extractSetCookies(response);

    if (this.isRedirect(response)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Gradescope returned a redirect without a location");

      const redirectUrl = this.resolveUrl(location);
      if (this.isLoginRedirect(response)) {
        this.authenticated = false;
        await this.login();
        return this.fetchPageWithRedirects(urlPath, redirectDepth + 1);
      }
      return this.fetchPageWithRedirects(redirectUrl, redirectDepth + 1);
    }

    if (!response.ok) {
      throw new Error(`Gradescope GET ${urlPath} failed (${response.status})`);
    }

    const html = await response.text();
    if (this.isLoginPage(html)) {
      this.authenticated = false;
      await this.login();
      return this.fetchPageWithRedirects(urlPath, redirectDepth + 1);
    }
    const newToken = this.extractCSRFToken(html);
    if (newToken) this.csrfToken = newToken;
    return html;
  }
}
