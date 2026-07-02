import { config } from "#src/common/cli.ts";
import { Impit } from "impit";

export const impit = new Impit({
    browser: config.browser,
    proxyUrl: config.proxyUrl || undefined,
    ignoreTlsErrors: true,
    timeout: config.timeout,
    headers: config.headers,
});
