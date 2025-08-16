export function xmlEscapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/\"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildTwimlConnectStream(relayUrl: string, parameters?: Record<string, string>): string {
  const safeUrl = xmlEscapeAttr(relayUrl);
  const paramXml = parameters
    ? Object.entries(parameters)
        .map(
          ([name, value]) =>
            `\n\t\t\t<Parameter name="${xmlEscapeAttr(name)}" value="${xmlEscapeAttr(value)}" />`
        )
        .join('')
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
\t<Connect>
\t\t<Stream url="${safeUrl}">${paramXml}
\t\t</Stream>
\t</Connect>
</Response>`;
}


