import fs from "node:fs";
import path from "node:path";

const DIR = process.env.SCRAPE_DIAGNOSTICS_DIR || ".scrape-diagnostics";

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export function redactDiagnostic(content, secrets = []) {
  let redacted = content.replace(/([?&]api_key=)[^&\s"']+/gi, "$1[REDACTED]");
  for (const secret of secrets.filter(Boolean)) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

export function writeDiagnostic(name, body, extension = "txt", { secrets = [] } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(name)}.${extension}`);
  const content = typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`;
  fs.writeFileSync(file, redactDiagnostic(content, secrets));
  console.warn(`  ! diagnostic saved: ${file}`);
  return file;
}
