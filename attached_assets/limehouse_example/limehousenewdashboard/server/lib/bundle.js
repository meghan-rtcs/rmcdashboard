// ── Server-side JSX bundling ─────────────────────────────────────────────────
// The frontend is authored as in-browser JSX (.jsx) historically compiled with
// @babel/standalone on every page load. That meant shipping ~3MB of Babel to the
// browser and recompiling ~100KB of JSX on each open -- the main source of slow
// first paint. Instead we compile the JSX ONCE here (on first request, cached in
// memory) and serve a single ready-to-run JS bundle. The .jsx files remain the
// source of truth.

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import babel from "@babel/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "..", "..", "Limehouse Revamp");

// Compiled in the same order the HTML used to inject them. Each is wrapped in an
// IIFE so top-level `const useState = ...` declarations don't collide across
// files (the original in-browser loader did the same).
const SOURCES = [
  "tweaks-panel.jsx",
  "components/shared.jsx",
  "components/var-a.jsx",
  "app-a.jsx",
];

let cached = null; // { code, etag }

function compileOne(relPath) {
  const abs = path.join(STATIC_ROOT, relPath);
  const src = fs.readFileSync(abs, "utf8");
  const { code } = babel.transformSync(src, {
    presets: ["@babel/preset-react"],
    filename: relPath,
    babelrc: false,
    configFile: false,
    compact: false,
  });
  return `\n// ── ${relPath} ──\n(function(){\n${code}\n})();\n`;
}

// Returns the compiled bundle, building + caching it on first call. Throws if a
// source file fails to compile so the failure is explicit rather than silent.
export function getBundle() {
  if (cached) return cached;
  const parts = SOURCES.map(compileOne);
  const code = parts.join("\n");
  // Cheap content hash for the ETag so browsers can cache across reloads.
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) | 0;
  cached = { code, etag: `"ls-${(hash >>> 0).toString(36)}-${code.length}"` };
  console.log(`[bundle] Compiled ${SOURCES.length} sources -> ${code.length} bytes`);
  return cached;
}

// Compile eagerly (e.g. at startup) so the first real request is already warm.
export function warmBundle() {
  try {
    getBundle();
  } catch (err) {
    console.error("[bundle] Precompile failed:", err.message);
  }
}
